import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb"
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime"
import sharp from "sharp"

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const s3 = new S3Client({})
const bedrock = new BedrockRuntimeClient({})

const TABLE = process.env.TICKET_TABLE
const BUCKET = process.env.TICKET_BUCKET
const MODEL_ID = process.env.NOVA_MODEL_ID

const MIN_SIZE = 10_000
const MAX_SIZE = 5_000_000

const TICKET_NUMBER = /^\d{4,8}$/

// Ticket-number region as fractions of the full image; see fixtures/roi-crops/geometry.json
const ROI = { left: 0.700, top: 0.005, width: 0.280, height: 0.070 }

const PROMPT = `This image is a crop of the top-right corner of a paper delivery ticket.
It contains a machine-printed serial number in red ink, 4-8 digits long.

Respond with only those digits and nothing else.

Respond with exactly NONE if any of these is true:
- no red printed number is visible
- any digit is cut off at the edge of the image
- you are not certain of every digit`

// Trim stray non-digits the model may wrap around its answer (quotes, punctuation).
// Edges only — a global strip would fuse a garbled "12 34" into a plausible 1234.
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

  const { width, height } = await sharp(imgBuffer).metadata()
  const roi = {
    left: Math.round(width * ROI.left),
    top: Math.round(height * ROI.top),
    width: Math.round(width * ROI.width),
    height: Math.round(height * ROI.height),
  }
  const roiBuffer = await sharp(imgBuffer).extract(roi).toBuffer()

  const res = await bedrock.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      messages: [
        {
          role: "user",
          content: [
            { image: { format: "jpeg", source: { bytes: roiBuffer } } },
            { text: PROMPT },
          ],
        },
      ],
      inferenceConfig: { maxTokens: 20, temperature: 0 },
    })
  )
  const answer = res.output?.message?.content?.[0]?.text?.trim() ?? ""
  console.log(
    "Ticket number extraction:",
    JSON.stringify({ answer, roi, imageWidth: width, imageHeight: height, inputTokens: res.usage?.inputTokens })
  )

  if (answer === "NONE") {
    return reject("ticket number not readable", imgBuffer)
  }

  const ticketNumber = normalizeDigits(answer)
  if (!TICKET_NUMBER.test(ticketNumber)) {
    return reject(`ticket number not detected (model returned ${JSON.stringify(answer.slice(0, 20))})`, imgBuffer)
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
