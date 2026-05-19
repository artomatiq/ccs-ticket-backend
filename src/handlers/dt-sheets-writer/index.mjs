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

const formatDate = (s) => {
  const [yyyy, mm, dd] = s.split("-")
  return `${Number(mm)}/${Number(dd)}/${yyyy}`
}



const formatTime12h = (t) => {
  if (!t) return ""
  const [hStr, mStr] = t.split(":")
  const h = Number(hStr)
  const m = Number(mStr)
  if (Number.isNaN(h) || Number.isNaN(m)) return t
  const period = h >= 12 ? "PM" : "AM"
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, "0")} ${period}`
}

export const handler = async (event) => {
  const record = JSON.parse(event.Records[0].body)
  const ticketId = record.dynamodb.NewImage.ticketId.S
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
  const { hours, amount, rate } = ticket

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

  const imageUrl = ticket.validatedKey
    ? `https://${BUCKET}.s3.amazonaws.com/${ticket.validatedKey}`
    : ""

  const sheets = await getSheets()

  const FIRST_DATA_ROW = 3

  const row = [
    formatDate(d.date),                                             // A — date
    d.customerName,                                                 // B — customer
    d.jobName,                                                      // C — job
    imageUrl                                                        // D — ticket #
      ? `=HYPERLINK("${imageUrl}", "${d.ticketNumber}")`
      : d.ticketNumber,
    formatTime12h(d.start),                                         // E — start time
    formatTime12h(d.stop),                                          // F — end time
    hours,                                                           // G — hours
    amount,                                                          // H — amount
    "",                                                              // I — invoice #
    "",                                                              // J — paid
    rate,                                                            // K — rate
    d.truckNo,                                                      // L — truck #
    "",                                                             // M — notes
    "",                                                             // N — flags
  ]

  const appendRes = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A${FIRST_DATA_ROW}:N`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  })

  const nextRow = Number(appendRes.data.updates.updatedRange.match(/!A(\d+):/)[1])

  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { ticketId },
      UpdateExpression:
        "SET #status = :populated, #ts.#populatedAt = :now, sheetsRow = :row",
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
