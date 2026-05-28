import { google } from "googleapis"
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager"

const secretsClient = new SecretsManagerClient({})
let drivePromise

async function getDrive() {
    if (!drivePromise) {
        drivePromise = (async () => {
            const result = await secretsClient.send(
                new GetSecretValueCommand({ SecretId: process.env.GOOGLE_SA_SECRET })
            )
            const credentials = JSON.parse(result.SecretString)
            const auth = new google.auth.GoogleAuth({
                credentials,
                scopes: ["https://www.googleapis.com/auth/drive.readonly"],
            })
            return google.drive({ version: "v3", auth })
        })().catch((err) => {
            drivePromise = undefined
            throw err
        })
    }
    return drivePromise
}

export const handler = async (event) => {
    const claims = event?.requestContext?.authorizer?.lambda || {}
    if (claims.user !== "ADMIN") {
        return { statusCode: 403, body: JSON.stringify({ error: "Forbidden" }) }
    }

    const fileId = event.pathParameters?.fileId ?? event.queryStringParameters?.fileId
    if (!fileId) {
        return { statusCode: 400, body: JSON.stringify({ error: "Missing fileId" }) }
    }

    try {
        const drive = await getDrive()
        const res = await drive.files.get(
            { fileId, alt: "media", supportsAllDrives: true },
            { responseType: "arraybuffer" }
        )
        const buffer = Buffer.from(res.data)
        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/pdf",
                "Cache-Control": "private, max-age=300",
            },
            body: buffer.toString("base64"),
            isBase64Encoded: true,
        }
    } catch (err) {
        console.error("Drive error:", err.code, err.message)
        return {
            statusCode: err.code || 500,
            body: JSON.stringify({ error: err.message }),
        }
    }
}
