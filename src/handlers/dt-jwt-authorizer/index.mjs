import { verify } from "../../shared/jwt.mjs"
import { loadParams } from "../../shared/ssm.mjs"

export const handler = async (event) => {
  try {
    const { JWT_SECRET } = await loadParams({
      JWT_SECRET: process.env.JWT_SECRET_PARAM,
    })

    const authHeader =
      event.headers?.authorization || event.headers?.Authorization
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return { isAuthorized: false }
    }

    const token = authHeader.slice(7)
    const result = verify({ token, secret: JWT_SECRET })

    if (!result.ok) {
      return {
        isAuthorized: false,
        context: { reason: result.reason.toUpperCase() },
      }
    }

    return {
      isAuthorized: true,
      context: { user: result.payload.user },
    }
  } catch (err) {
    console.error(err)
    return { isAuthorized: false }
  }
}