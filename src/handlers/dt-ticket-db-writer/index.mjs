import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb"
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge"

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const events = new EventBridgeClient({})

const TABLE = process.env.TICKET_TABLE
const BUS = process.env.EVENT_BUS_NAME

export const handler = async (event) => {
  try {
    const record = event.Records[0]
    const bucket = record.s3.bucket.name
    const key = decodeURIComponent(record.s3.object.key)

    const match = key.match(/^raw\/([0-9A-HJKMNP-TV-Z]{26})\.jpg$/)
    if (!match) {
      console.error("Unexpected key format:", key)
      return
    }
    const ticketId = match[1]

    await dynamo.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { ticketId },
        UpdateExpression: "SET #status = :uploaded, #ts.#uploadedAt = :now",
        ConditionExpression: "#status = :awaiting",
        ExpressionAttributeNames: {
          "#status": "status",
          "#ts": "timestamps",
          "#uploadedAt": "uploadedAt",
        },
        ExpressionAttributeValues: {
          ":uploaded": "uploaded",
          ":awaiting": "awaiting-upload",
          ":now": Date.now(),
        },
      })
    )

    await events.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: BUS,
            Source: "dt.ticket",
            DetailType: "TicketUploaded",
            Detail: JSON.stringify({ ticketId, bucket, rawKey: key }),
          },
        ],
      })
    )

    console.log("Marked uploaded + event published:", ticketId)
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      console.log("Ticket not in awaiting-upload state. Ignoring.")
      return
    }
    console.error("TicketDbWriter error:", err)
    throw err
  }
}
