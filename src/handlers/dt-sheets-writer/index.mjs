import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb"
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager"
import { google } from "googleapis"
import { loadParams } from "../../shared/ssm.mjs"

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const secrets = new SecretsManagerClient({})

const TABLE = process.env.TICKET_TABLE
const NUMBER_TABLE = process.env.TICKET_NUMBER_TABLE
const BUCKET = process.env.TICKET_BUCKET
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

  const { Item: ticket } = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { ticketId } }))
  if (!ticket) {
    console.error("Ticket not found, discarding:", ticketId)
    return
  }
  const { confirmedData: d, hours, amount, rate, validatedKey } = ticket

  const { SPREADSHEET_ID } = await loadParams({
    SPREADSHEET_ID: process.env.SPREADSHEET_ID_PARAM,
  })

  const imageUrl = validatedKey
    ? `https://${BUCKET}.s3.amazonaws.com/${validatedKey}`
    : ""

  const sheets = await getSheets()

  const FIRST_DATA_ROW = 3

  const row = [
    formatDate(d.date),                                              // A — date
    d.customerName,                                                  // B — customer
    d.jobName,                                                       // C — job
    imageUrl                                                         // D — ticket #
      ? `=HYPERLINK("${imageUrl}", "${d.ticketNumber}")`
      : d.ticketNumber,
    formatTime12h(d.start),                                          // E — start time
    formatTime12h(d.stop),                                           // F — end time
    hours,                                                           // G — hours
    amount,                                                          // H — amount
    "",                                                              // I — invoice #
    "",                                                              // J — paid
    rate,                                                            // K — rate
    d.truckNo,                                                       // L — truck #
    "",                                                              // M — notes
    "",                                                              // N — flags
  ]

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A${FIRST_DATA_ROW}:N`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  })

  const now = Date.now()

  try {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: { ticketId },
              UpdateExpression: "SET #status = :populated, #ts.#populatedAt = :now",
              ConditionExpression: "#status = :confirmed",
              ExpressionAttributeNames: {
                "#status": "status",
                "#ts": "timestamps",
                "#populatedAt": "populatedAt",
              },
              ExpressionAttributeValues: {
                ":populated": "populated",
                ":confirmed": "confirmed",
                ":now": now,
              },
            },
          },
          {
            Update: {
              TableName: NUMBER_TABLE,
              Key: { ticketNumber: d.ticketNumber },
              UpdateExpression: "SET #status = :populated, populatedAt = :now",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":populated": "populated", ":now": now },
            },
          },
        ],
      })
    )
  } catch (err) {
    if (err.name === "TransactionCanceledException") {
      console.log("Ticket already populated, skipping:", ticketId)
      return
    }
    throw err
  }

  console.log("Populated:", ticketId)
}
