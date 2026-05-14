import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb"
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge"

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const events = new EventBridgeClient({})

const TABLE = process.env.TICKET_TABLE
const NUMBER_TABLE = process.env.TICKET_NUMBER_TABLE
const BUS = process.env.EVENT_BUS_NAME

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

const normalizeDate = (date) => {
  if (!date) throw new Error("Missing date")
  if (date.includes("-")) {
    const [yyyy, mm, dd] = date.split("-")
    return `${mm.padStart(2, "0")}/${dd.padStart(2, "0")}/${yyyy}`
  }
  if (date.includes("/")) {
    const [mm, dd, yy] = date.split("/")
    const year = yy.length === 2 ? "20" + yy : yy
    return `${mm.padStart(2, "0")}/${dd.padStart(2, "0")}/${year}`
  }
  throw new Error(`Invalid date format: ${date}`)
}

export const handler = async (event) => {
  const user = event.requestContext?.authorizer?.lambda?.user
  if (!user) return json(401, { error: "Unauthorized" })

  const ticketId = event.pathParameters?.ticketId
  if (!ticketId) return json(400, { error: "Missing ticketId" })

  let confirmedData
  try {
    confirmedData = JSON.parse(event.body || "{}")
  } catch {
    return json(400, { error: "Invalid JSON body" })
  }

  const ticketNumber = confirmedData.ticketNumber
  if (!ticketNumber) return json(400, { error: "Missing ticketNumber" })

  const existing = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { ticketId } }))
  const t = existing.Item
  if (!t) return json(404, { error: "Ticket not found" })
  if (t.userId !== user && user !== "ADMIN") return json(403, { error: "Forbidden" })
  if (t.status !== "extracted") return json(409, { error: `Ticket is in '${t.status}' state, not 'extracted'` })

  try {
    confirmedData.date = normalizeDate(confirmedData.date)
  } catch (err) {
    return json(400, { error: err.message })
  }

  const now = Date.now()

  try {
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: { ticketId },
              ConditionExpression: "#status = :extracted",
              UpdateExpression:
                "SET #status = :confirmed, confirmedData = :data, #ts.#confirmedAt = :now, ticketDate = :ticketDate",
              ExpressionAttributeNames: {
                "#status": "status",
                "#ts": "timestamps",
                "#confirmedAt": "confirmedAt",
              },
              ExpressionAttributeValues: {
                ":extracted": "extracted",
                ":confirmed": "confirmed",
                ":data": confirmedData,
                ":now": now,
                ":ticketDate": confirmedData.date,
              },
            },
          },
          {
            Put: {
              TableName: NUMBER_TABLE,
              Item: {
                ticketNumber,
                ticketId,
                status: "confirmed",
                createdAt: now,
              },
              ConditionExpression: "attribute_not_exists(ticketNumber)",
            },
          },
        ],
      })
    )
  } catch (err) {
    if (err.name === "TransactionCanceledException") {
      return json(409, { error: "Ticket not in 'extracted' state, or ticketNumber already filed" })
    }
    throw err
  }

  await events.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: BUS,
          Source: "dt.ticket",
          DetailType: "TicketConfirmed",
          Detail: JSON.stringify({ ticketId, ticketNumber, confirmedAt: now }),
        },
      ],
    })
  )

  console.log("Confirmed:", ticketId, ticketNumber)
  return json(200, { ticketId, ticketNumber, status: "confirmed" })
}
