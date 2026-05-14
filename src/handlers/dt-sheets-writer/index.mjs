import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb"
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager"
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge"
import { google } from "googleapis"
import { loadParams } from "../../shared/ssm.mjs"

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const secrets = new SecretsManagerClient({})
const events = new EventBridgeClient({})

const TABLE = process.env.TICKET_TABLE
const NUMBER_TABLE = process.env.TICKET_NUMBER_TABLE
const BUCKET = process.env.TICKET_BUCKET
const BUS = process.env.EVENT_BUS_NAME
const SHEET_NAME = process.env.SHEET_NAME
const RATE = Number(process.env.RATE)
const MAX_AMOUNT = 5000
const GOOGLE_SA_SECRET = process.env.GOOGLE_SA_SECRET

let sheetsClient = null
const getSheets = async () => {
  if (sheetsClient) return sheetsClient
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: GOOGLE_SA_SECRET }))
  const creds = JSON.parse(res.SecretString)
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  })
  sheetsClient = google.sheets({ version: "v4", auth })
  return sheetsClient
}

const parseTime = (t) => (t ? new Date(`1970-01-01T${t}Z`) : null)

const computeHoursAndAmount = (d) => {
  const start = parseTime(d.start)
  const stop = parseTime(d.stop)
  if (!start || !stop) return { hours: 0, amount: 0 }
  const hours = Math.round(((stop - start) / (1000 * 60 * 60)) * 4) / 4
  return { hours, amount: hours * RATE }
}

export const handler = async (event) => {
  const ticketId = event.detail.ticketId
  console.log("SheetsWriter triggered:", ticketId)

  let ticket
  try {
    const res = await dynamo.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { ticketId },
        UpdateExpression: "SET #status = :populating, #ts.#populatingAt = :now",
        ConditionExpression: "#status = :confirmed",
        ExpressionAttributeNames: {
          "#status": "status",
          "#ts": "timestamps",
          "#populatingAt": "populatingAt",
        },
        ExpressionAttributeValues: {
          ":populating": "populating",
          ":confirmed": "confirmed",
          ":now": Date.now(),
        },
        ReturnValues: "ALL_NEW",
      })
    )
    ticket = res.Attributes
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      console.log("Ticket not in 'confirmed' state, ignoring:", ticketId)
      return
    }
    throw err
  }

  const { SPREADSHEET_ID } = await loadParams({
    SPREADSHEET_ID: process.env.SPREADSHEET_ID_PARAM,
  })

  const d = ticket.confirmedData
  const { hours, amount } = computeHoursAndAmount(d)

  const reject = async (msg) => {
    await dynamo.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { ticketId },
        UpdateExpression: "SET #status = :rejected, #ts.#rejectedAt = :now, statusMessage = :msg",
        ConditionExpression: "#status = :populating",
        ExpressionAttributeNames: {
          "#status": "status",
          "#ts": "timestamps",
          "#rejectedAt": "rejectedAt",
        },
        ExpressionAttributeValues: {
          ":populating": "populating",
          ":rejected": "rejected",
          ":now": Date.now(),
          ":msg": msg,
        },
      })
    )
    console.log("Rejected:", ticketId, msg)
  }

  if (hours <= 0) return reject("Stop time is not after start time")
  if (amount > MAX_AMOUNT) return reject(`Amount $${amount} exceeds maximum of $${MAX_AMOUNT}`)

  const imageUrl = ticket.validatedKey
    ? `https://${BUCKET}.s3.amazonaws.com/${ticket.validatedKey}`
    : ""

  const sheets = await getSheets()

  const FIRST_DATA_ROW = 3
  const colRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A${FIRST_DATA_ROW}:A`,
  })
  const nextRow = FIRST_DATA_ROW + (colRes.data.values || []).length

  const row = [
    d.date,                                                         // A — date
    d.customerName,                                                 // B — customer
    d.jobName,                                                      // C — job
    imageUrl                                                        // D — ticket #
      ? `=HYPERLINK("${imageUrl}", "${d.ticketNumber}")`
      : d.ticketNumber,
    d.start,                                                        // E — start time
    d.stop,                                                         // F — end time
    hours,                                                          // G — hours
    amount,                                                         // H — amount
    "",                                                             // I — invoice #
    "",                                                             // J — paid
    RATE,                                                           // K — rate
    d.truckNo,                                                      // L — truck #
    "",                                                             // M — notes
    "",                                                             // N — flags
  ]

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A${nextRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  })

  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { ticketId },
      UpdateExpression:
        "SET #status = :populated, #ts.#populatedAt = :now, hours = :hours, amount = :amount, rate = :rate, sheetsRow = :row",
      ConditionExpression: "#status = :populating",
      ExpressionAttributeNames: {
        "#status": "status",
        "#ts": "timestamps",
        "#populatedAt": "populatedAt",
      },
      ExpressionAttributeValues: {
        ":populated": "populated",
        ":populating": "populating",
        ":now": Date.now(),
        ":hours": hours,
        ":amount": amount,
        ":rate": RATE,
        ":row": nextRow,
      },
    })
  )

  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: NUMBER_TABLE,
        Key: { ticketNumber: d.ticketNumber },
        UpdateExpression: "SET #status = :populated, populatedAt = :now",
        ConditionExpression: "#status = :confirmed",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":populated": "populated",
          ":confirmed": "confirmed",
          ":now": Date.now(),
        },
      })
    )
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      console.log("ticket-number-db not in 'confirmed' state, skipping flip:", d.ticketNumber)
    } else {
      throw err
    }
  }

  await events.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: BUS,
          Source: "dt.ticket",
          DetailType: "TicketPopulated",
          Detail: JSON.stringify({
            ticketId,
            ticketNumber: d.ticketNumber,
            sheetsRow: nextRow,
            amount,
          }),
        },
      ],
    })
  )

  console.log("Populated:", ticketId, "row:", nextRow)
}
