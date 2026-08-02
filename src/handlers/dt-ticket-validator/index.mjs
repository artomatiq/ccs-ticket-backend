import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb"
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { TextractClient, DetectDocumentTextCommand } from "@aws-sdk/client-textract"

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const s3 = new S3Client({})
const textract = new TextractClient({})

const TABLE = process.env.TICKET_TABLE
const BUCKET = process.env.TICKET_BUCKET

const MIN_SIZE = 10_000
const MAX_SIZE = 5_000_000

// Textract merges the ticket's printed corner registration marks into the
// adjacent word (e.g. "140378]"). Strip non-digits at the edges only — a
// global strip would fuse a garbled "12 34AB" into a plausible-looking 1234.
const normalizeDigits = (t) => t.replace(/^\D+|\D+$/g, "")

const streamToBuffer = async (stream) => {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

export const handler = async (event) => {
  const img = event.Records[0].dynamodb.NewImage
  const ticketId = img.ticketId.S
  const rawKey = img.rawKey.S

  // try {
  //   await dynamo.send(
  //     new UpdateCommand({
  //       TableName: TABLE,
  //       Key: { ticketId },
  //       UpdateExpression: "SET #status = :validating, #ts.#validatingAt = :now",
  //       ConditionExpression: "#status = :uploaded",
  //       ExpressionAttributeNames: {
  //         "#status": "status",
  //         "#ts": "timestamps",
  //         "#validatingAt": "validatingAt",
  //       },
  //       ExpressionAttributeValues: {
  //         ":validating": "validating",
  //         ":uploaded": "uploaded",
  //         ":now": Date.now(),
  //       },
  //     })
  //   )
  // } catch (err) {
  //   if (err.name === "ConditionalCheckFailedException") {
  //     console.log("Ticket not in 'uploaded' state, ignoring:", ticketId)
  //     return
  //   }
  //   throw err
  // }

  const reject = async (reason, imgBuffer) => {
    try {
      await dynamo.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { ticketId },
          UpdateExpression: "SET #status = :rejected, #ts.#rejectedAt = :now, statusMessage = :msg",
          ConditionExpression: "#status = :uploaded",
          ExpressionAttributeNames: {
            "#status": "status",
            "#ts": "timestamps",
            "#rejectedAt": "rejectedAt",
          },
          ExpressionAttributeValues: {
            ":rejected": "rejected",
            ":uploaded": "uploaded",
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

  const inTicketNumberRegion = (b) => {
    const box = b.Geometry?.BoundingBox
    return box && box.Top <= 0.1 && box.Left >= 0.5
  }

  const textractRes = await textract.send(
    new DetectDocumentTextCommand({
      Document: { Bytes: imgBuffer },
    })
  )
  const ticketWordBlocks = textractRes.Blocks.filter(
    (b) => b.BlockType === "WORD" && inTicketNumberRegion(b)
  )
  const candidates = ticketWordBlocks.map((b) => ({
    text: b.Text,
    digits: normalizeDigits(b.Text),
    confidence: b.Confidence,
    top: b.Geometry.BoundingBox.Top,
    left: b.Geometry.BoundingBox.Left,
  }))
  console.log(
    "Ticket number candidates:",
    JSON.stringify(
      candidates.map((c) => ({
        text: c.text,
        digits: c.digits,
        confidence: Math.round(c.confidence),
        top: Number(c.top.toFixed(3)),
        left: Number(c.left.toFixed(3)),
      }))
    )
  )
  const ticketWords = candidates.map((c) => c.text)
  const ticketNumber = candidates
    .filter((c) => c.confidence >= 50 && /^\d{4,10}$/.test(c.digits))
    .sort((a, b) => b.confidence - a.confidence)[0]?.digits

  if (!ticketNumber) {
    return reject("ticket number not detected", imgBuffer)
  }
  console.log("Extracted ticket number:", ticketNumber, "from candidates:", JSON.stringify(ticketWords))

  const validatedKey = `validated/${ticketId}.jpg`
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: validatedKey,
      Body: imgBuffer,
      ContentType: "image/jpeg",
    })
  )

  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { ticketId },
      UpdateExpression: "SET #status = :validated, #ts.#validatedAt = :now, validatedKey = :validatedKey, ticketNumber = :ticketNumber",
      ConditionExpression: "#status = :uploaded",
      ExpressionAttributeNames: {
        "#status": "status",
        "#ts": "timestamps",
        "#validatedAt": "validatedAt",
      },
      ExpressionAttributeValues: {
        ":uploaded": "uploaded",
        ":validated": "validated",
        ":now": Date.now(),
        ":validatedKey": validatedKey,
        ":ticketNumber": ticketNumber,
      },
    })
  )

  console.log("Validated:", ticketId, ticketNumber)
}
