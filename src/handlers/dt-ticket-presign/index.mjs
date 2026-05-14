import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { ulid } from "ulid"

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const s3 = new S3Client({})

const TABLE = process.env.TICKET_TABLE
const BUCKET = process.env.TICKET_BUCKET
const URL_EXPIRY_SECONDS = 300

export const handler = async (event) => {
  try {
    const userId = event.requestContext?.authorizer?.lambda?.user
    if (!userId) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Unauthorized" }),
      }
    }

    const ticketId = ulid()
    const rawKey = `raw/${ticketId}.jpg`
    const now = Date.now()

    await dynamo.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          ticketId,
          status: "awaiting-upload",
          userId,
          rawKey,
          timestamps: { createdAt: now },
        },
        ConditionExpression: "attribute_not_exists(ticketId)",
      })
    )

    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: rawKey,
        ContentType: "image/jpeg",
      }),
      { expiresIn: URL_EXPIRY_SECONDS }
    )

    return {
      statusCode: 200,
      body: JSON.stringify({ ticketId, uploadUrl }),
    }
  } catch (err) {
    console.error(err)
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal error" }),
    }
  }
}
