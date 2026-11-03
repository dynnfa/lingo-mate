import type { CommunicationEnvironment } from './environment'
export function schedule(
  env: CommunicationEnvironment,
  callback: () => void,
  ms: number
): () => void {
  if (env.schedule) return env.schedule(callback, ms)
  const timer = setTimeout(callback, ms)
  return () => clearTimeout(timer)
}
export async function bounded<T>(
  env: CommunicationEnvironment,
  work: Promise<T>,
  ms: number,
  timeout: () => T
): Promise<T> {
  let cancel = (): void => {}
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        cancel = schedule(env, () => resolve(timeout()), ms)
      })
    ])
  } finally {
    cancel()
  }
}
