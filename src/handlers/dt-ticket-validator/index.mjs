import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb"
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { TextractClient, DetectDocumentTextCommand } from "@aws-sdk/client-textract"
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge"
import sharp from "sharp"

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const s3 = new S3Client({})
const textract = new TextractClient({})
const events = new EventBridgeClient({})

const TABLE = process.env.TICKET_TABLE
const NUMBER_TABLE = process.env.TICKET_NUMBER_TABLE
const BUCKET = process.env.TICKET_BUCKET
const BUS = process.env.EVENT_BUS_NAME

const MIN_SIZE = 10_000
const MAX_SIZE = 5_000_000

const streamToBuffer = async (stream) => {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

export const handler = async (event) => {
  const ticketId = event.detail.ticketId
  const rawKey = event.detail.rawKey
  console.log("TicketValidator triggered:", ticketId)

  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { ticketId },
        UpdateExpression: "SET #status = :validating, #ts.#validatingAt = :now",
        ConditionExpression: "#status = :uploaded",
        ExpressionAttributeNames: {
          "#status": "status",
          "#ts": "timestamps",
          "#validatingAt": "validatingAt",
        },
        ExpressionAttributeValues: {
          ":validating": "validating",
          ":uploaded": "uploaded",
          ":now": Date.now(),
        },
      })
    )
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      console.log("Ticket not in 'uploaded' state, ignoring:", ticketId)
      return
    }
    throw err
  }

  const reject = async (reason, imgBuffer) => {
    try {
      await dynamo.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { ticketId },
          UpdateExpression: "SET #status = :rejected, #ts.#rejectedAt = :now, statusMessage = :msg",
          ConditionExpression: "#status = :validating",
          ExpressionAttributeNames: {
            "#status": "status",
            "#ts": "timestamps",
            "#rejectedAt": "rejectedAt",
          },
          ExpressionAttributeValues: {
            ":rejected": "rejected",
            ":validating": "validating",
            ":now": Date.now(),
            ":msg": reason,
          },
        })
      )
      if (imgBuffer) {
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: `rejected/${ticketId}.jpg`,
            Body: imgBuffer,
            ContentType: "image/jpeg",
          })
        )
      }
      console.log("Rejected:", reason)
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        console.log("Reject no-op (status changed):", ticketId)
        return
      }
      throw err
    }
  }

  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: rawKey }))
  const imgBuffer = await streamToBuffer(obj.Body)

  if (obj.ContentType !== "image/jpeg") {
    return reject("unsupported file type", imgBuffer)
  }

  const size = imgBuffer.length
  if (size < MIN_SIZE || size > MAX_SIZE) {
    return reject(`file size out of range (${size} bytes)`, imgBuffer)
  }

  const { width, height } = await sharp(imgBuffer).metadata()
  const roiBuffer = await sharp(imgBuffer)
    .extract({
      left: Math.round(width * 0.667),
      top: Math.round(height * 0.005),
      width: Math.round(width * 0.333),
      height: Math.round(height * 0.070),
    })
    .toBuffer()

  const textractRes = await textract.send(
    new DetectDocumentTextCommand({
      Document: { Bytes: roiBuffer },
    })
  )
  const ticketWords = textractRes.Blocks
    .filter((b) => b.BlockType === "WORD")
    .map((b) => b.Text)
  const ticketNumber = ticketWords.find((t) => /^\d{4,10}$/.test(t))

  if (!ticketNumber) {
    return reject("ticket number not detected", imgBuffer)
  }
  console.log("Extracted ticket number:", ticketNumber)

  const validatedKey = `validated/${ticketId}.jpg`
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: validatedKey,
      Body: imgBuffer,
      ContentType: "image/jpeg",
    })
  )

  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: NUMBER_TABLE,
        Key: { ticketNumber },
        UpdateExpression: "SET createdAt = :now",
        ConditionExpression: "attribute_not_exists(ticketNumber)",
        ExpressionAttributeValues: {
          ":now": Date.now(),
        },
      })
    )
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return reject(`Ticket ${ticketNumber} already filed`, imgBuffer)
    }
    throw err
  }



  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { ticketId },
      UpdateExpression: "SET #status = :validated, #ts.#validatedAt = :now, validatedKey = :validatedKey, ticketNumber = :ticketNumber",
      ConditionExpression: "#status = :validating",
      ExpressionAttributeNames: {
        "#status": "status",
        "#ts": "timestamps",
        "#validatedAt": "validatedAt",
      },
      ExpressionAttributeValues: {
        ":validating": "validating",
        ":validated": "validated",
        ":now": Date.now(),
        ":validatedKey": validatedKey,
        ":ticketNumber": ticketNumber,
      },
    })
  )

  await events.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: BUS,
          Source: "dt.ticket",
          DetailType: "TicketValidated",
          Detail: JSON.stringify({ ticketId, ticketNumber, bucket: BUCKET, validatedKey }),
        },
      ],
    })
  )

  console.log("Validated:", ticketId, ticketNumber)
}
