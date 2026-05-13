import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm"

const ssm = new SSMClient({})
const cache = new Map()

export const loadParams = (labelToPath) => {
  const paths = Object.values(labelToPath)
  const cacheKey = paths.slice().sort().join(",")
  if (cache.has(cacheKey)) return cache.get(cacheKey)

  const promise = (async () => {
    const res = await ssm.send(
      new GetParametersCommand({ Names: paths, WithDecryption: true })
    )
    if (res.InvalidParameters?.length) {
      throw new Error(
        `Missing SSM parameters: ${res.InvalidParameters.join(", ")}`
      )
    }
    const byPath = Object.fromEntries(
      res.Parameters.map((p) => [p.Name, p.Value])
    )
    return Object.fromEntries(
      Object.entries(labelToPath).map(([label, path]) => [label, byPath[path]])
    )
  })()

  cache.set(cacheKey, promise)
  return promise
}
