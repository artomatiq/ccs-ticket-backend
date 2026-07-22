import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb"
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { TextractClient, DetectDocumentTextCommand } from "@aws-sdk/client-textract"
import sharp from "sharp"

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const s3 = new S3Client({})
const textract = new TextractClient({})

const TABLE = process.env.TICKET_TABLE
const BUCKET = process.env.TICKET_BUCKET

const MIN_SIZE = 10_000
const MAX_SIZE = 5_000_000

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

  const { width, height } = await sharp(imgBuffer).metadata()
  const left = Math.round(width * 0.55)
  const top = Math.round(height * 0.005)
  const roi = {
    left,
    top,
    width: width - left,
    height: Math.round(height * 0.070),
  }
  const roiBuffer = await sharp(imgBuffer).extract(roi).toBuffer()
  console.log("Ticket number ROI:", JSON.stringify({ imageWidth: width, imageHeight: height, ...roi }))

  const textractRes = await textract.send(
    new DetectDocumentTextCommand({
      Document: { Bytes: roiBuffer },
    })
  )
  const ticketWordBlocks = textractRes.Blocks.filter((b) => b.BlockType === "WORD")
  console.log(
    "Ticket number ROI words:",
    JSON.stringify(
      ticketWordBlocks.map((b) => ({ text: b.Text, confidence: Math.round(b.Confidence) }))
    )
  )
  const ticketWords = ticketWordBlocks.map((b) => b.Text)
  const ticketNumber = ticketWordBlocks
    .filter((b) => b.Confidence >= 50 && /^\d{4,10}$/.test(b.Text))
    .sort((a, b) => b.Confidence - a.Confidence)[0]?.Text

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
