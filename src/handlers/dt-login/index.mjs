import { sign } from "../../shared/jwt.mjs"
import { loadParams } from "../../shared/ssm.mjs"

export const handler = async (event) => {
    if (!event.body) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Missing body" }),
        }
    }
    let passcode
    try {
      ({passcode} = JSON.parse(event.body))
    } catch (err) {
      console.error(err)
      return {
        statusCode: 400,
        body: JSON.stringify({error: 'Invalid JSON body'})
      }
    }
    try {
        const { JWT_SECRET, VV01_PASSCODE, VV02_PASSCODE, ADMIN_PASSCODE } =
            await loadParams({
                JWT_SECRET: process.env.JWT_SECRET_PARAM,
                VV01_PASSCODE: process.env.VV01_PASSCODE_PARAM,
                VV02_PASSCODE: process.env.VV02_PASSCODE_PARAM,
                ADMIN_PASSCODE: process.env.ADMIN_PASSCODE_PARAM,
            })
        const passcodeMap = {
            [VV01_PASSCODE]: "VV01",
            [VV02_PASSCODE]: "VV02",
            [ADMIN_PASSCODE]: "ADMIN",
        }
        const userId = passcodeMap[passcode]
        if (!userId) {
            return {
                statusCode: 401,
                body: JSON.stringify({ error: "Incorrect passcode" }),
            }
        }
        const token = sign({ payload: { user: userId }, secret: JWT_SECRET })
        return { statusCode: 200, body: JSON.stringify({ token }) }
    } catch (err) {
        console.error(err)
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Internal error" }),
        }
    }
}
