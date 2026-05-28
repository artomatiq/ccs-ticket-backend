import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb"
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const s3 = new S3Client({})

const TABLE = process.env.TICKET_TABLE
const BUCKET = process.env.TICKET_BUCKET
const URL_EXPIRY_SECONDS = 900

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

const presignGet = (key) =>
  getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    expiresIn: URL_EXPIRY_SECONDS,
  })

export const handler = async (event) => {
  const user = event.requestContext?.authorizer?.lambda?.user
  if (!user) return json(401, { error: "Unauthorized" })

  const ticketId = event.pathParameters?.ticketId
  if (ticketId) return getOne(ticketId, user)
  return list(user, event.queryStringParameters?.status)
}

const getOne = async (ticketId, user) => {
  const res = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { ticketId } }))
  const t = res.Item
  if (!t) return json(404, { error: "Ticket not found" })
  if (t.userId !== user && user !== "ADMIN") return json(403, { error: "Forbidden" })

  const body = {
    ticketId: t.ticketId,
    status: t.status,
    statusMessage: t.statusMessage ?? null,
  }
  if (t.status === "extracted" && t.validatedKey) {
    body.extraction = t.extraction ? { data: t.extraction.data, apex: t.extraction.apex } : null
    body.imageUrl = await presignGet(t.validatedKey)
  }
  return json(200, body)
}

const queryByStatus = (status) =>
  dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: "status-ticketDate-index",
      KeyConditionExpression: "#status = :status",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":status": status },
    })
  )

const list = async (user, status) => {
  if (user !== "ADMIN") return json(403, { error: "Admin only" })

  let items
  if (status === "populated") {
    const [populated, confirmed] = await Promise.all([
      queryByStatus("populated"),
      queryByStatus("confirmed"),
    ])
    items = [...(populated.Items ?? []), ...(confirmed.Items ?? [])]
  } else if (status) {
    const res = await queryByStatus(status)
    items = res.Items ?? []
  } else {
    const res = await dynamo.send(new ScanCommand({ TableName: TABLE }))
    items = res.Items ?? []
  }

  const tickets = await Promise.all(
    items.map(async (t) => ({
      ticketId: t.ticketId,
      status: t.status,
      statusMessage: t.statusMessage ?? null,
      ticketNumber: t.ticketNumber ?? null,
      ticketDate: t.ticketDate ?? null,
      userId: t.userId ?? null,
      confirmedData: t.confirmedData ?? null,
      confirmedAt: t.confirmedAt ?? null,
      validatedKey: t.validatedKey ?? null,
      hours: t.hours ?? null,
      amount: t.amount ?? null,
      imageUrl: t.validatedKey ? await presignGet(t.validatedKey) : null,
    }))
  )
  return json(200, { tickets })
}
