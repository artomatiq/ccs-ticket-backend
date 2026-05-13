import crypto from "crypto"

const HEADER = Buffer.from(
  JSON.stringify({ alg: "HS256", typ: "JWT" })
).toString("base64url")

const hmac = (data, secret) =>
  crypto.createHmac("sha256", secret).update(data).digest("base64url")

export const sign = ({ payload, secret, expiresInSeconds = 1800 }) => {
  const full = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  }
  const encoded = Buffer.from(JSON.stringify(full)).toString("base64url")
  const signature = hmac(`${HEADER}.${encoded}`, secret)
  return `${HEADER}.${encoded}.${signature}`
}

export const verify = ({ token, secret }) => {
  const parts = token.split(".")
  if (parts.length !== 3) return { ok: false, reason: "malformed" }
  const [header, payload, signature] = parts

  const expected = hmac(`${header}.${payload}`, secret)
  const sigBuf = Buffer.from(signature)
  const expBuf = Buffer.from(expected)
  if (
    sigBuf.length !== expBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expBuf)
  ) {
    return { ok: false, reason: "invalid_signature" }
  }

  let decoded
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString())
  } catch {
    return { ok: false, reason: "malformed" }
  }

  if (decoded.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "expired" }
  }

  return { ok: true, payload: decoded }
}