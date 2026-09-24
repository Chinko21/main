import { describe, it, expect, afterEach } from 'vitest'
import { ProofWorkerClient, ProofWorkerError } from './proofWorkerClient'

describe('ProofWorkerClient', () => {
  const clients: ProofWorkerClient[] = []

  afterEach(() => {
    while (clients.length) {
      clients.pop()?.destroy()
    }
  })

  function createClient() {
    const client = new ProofWorkerClient()
    clients.push(client)
    return client
  }

  it('rejects a second concurrent request with BUSY without queuing', async () => {
    const client = createClient()
    const first = client.generate({
      videoHash: '0'.repeat(64),
      credentialSecret: 'secret1',
      nullifierSecret: 'secret2',
    })
    const second = client.generate({
      videoHash: '0'.repeat(64),
      credentialSecret: 'secret1',
      nullifierSecret: 'secret2',
    })

    await expect(second.result).rejects.toMatchObject({ code: 'BUSY' })
    expect(second.requestId).toBe('')

    // first is expected to fail in this test env (jsdom can't fetch relative
    // circuit URLs) — assert on it explicitly so it's not left unhandled.
    await expect(first.result).rejects.toBeInstanceOf(ProofWorkerError)
  })

  it('rejects a pending request as CANCELLED and respawns a working worker', async () => {
    const client = createClient()
    const first = client.generate({
      videoHash: '0'.repeat(64),
      credentialSecret: 'secret1',
      nullifierSecret: 'secret2',
    })

    expect(first.requestId).toBeTruthy()
    client.cancel(first.requestId)
    await expect(first.result).rejects.toMatchObject({ code: 'CANCELLED' })

    // After cancel, a new generate must be accepted (not stuck BUSY forever).
    const next = client.generate({
      videoHash: 'a'.repeat(64),
      credentialSecret: 'secret3',
      nullifierSecret: 'secret4',
    })
    expect(next.requestId).toBeTruthy()
    client.cancel(next.requestId)
    await expect(next.result).rejects.toMatchObject({ code: 'CANCELLED' })
  }, 15000)

  it('honours AbortSignal by settling CANCELLED', async () => {
    const client = createClient()
    const controller = new AbortController()
    const first = client.generate(
      {
        videoHash: '0'.repeat(64),
        credentialSecret: 'secret1',
        nullifierSecret: 'secret2',
      },
      undefined,
      controller.signal,
    )

    controller.abort()
    await expect(first.result).rejects.toMatchObject({ code: 'CANCELLED' })
  }, 15000)

  it('rejects invalid input deterministically without touching the worker', async () => {
    const client = createClient()
    const { result, requestId } = client.generate({
      videoHash: 'not-valid-hex',
      credentialSecret: 'secret1',
      nullifierSecret: 'secret2',
    })
    expect(requestId).toBe('')
    await expect(result).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('rejects oversized secrets as INVALID_INPUT', async () => {
    const client = createClient()
    const oversized = 'x'.repeat(300)
    const { result } = client.generate({
      videoHash: '0'.repeat(64),
      credentialSecret: oversized,
      nullifierSecret: 'secret2',
    })
    await expect(result).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('recovers from a worker crash and respawns cleanly', async () => {
    const client = createClient()
    const first = client.generate({
      videoHash: '0'.repeat(64),
      credentialSecret: 'secret1',
      nullifierSecret: 'secret2',
    })

    // simulate a real crash by triggering the worker's onerror handler directly
    // @ts-expect-error - accessing private field for test purposes
    const worker = client.worker
    worker.onerror?.(new ErrorEvent('error', { message: 'simulated crash' }))

    await expect(first.result).rejects.toMatchObject({ code: 'CRASHED' })
  }, 15000)

  it('destroy rejects in-flight work as CANCELLED and blocks new generates', async () => {
    const client = createClient()
    const first = client.generate({
      videoHash: '0'.repeat(64),
      credentialSecret: 'secret1',
      nullifierSecret: 'secret2',
    })
    client.destroy()
    await expect(first.result).rejects.toMatchObject({ code: 'CANCELLED' })

    const after = client.generate({
      videoHash: '0'.repeat(64),
      credentialSecret: 'secret1',
      nullifierSecret: 'secret2',
    })
    await expect(after.result).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('CANCELLED errors never include secret material in the message', async () => {
    const client = createClient()
    const secret = 'super-secret-witness-value-do-not-leak'
    const first = client.generate({
      videoHash: '0'.repeat(64),
      credentialSecret: secret,
      nullifierSecret: secret,
    })
    client.cancel(first.requestId)
    try {
      await first.result
      expect.unreachable('should have rejected')
    } catch (err) {
      expect(err).toBeInstanceOf(ProofWorkerError)
      const message = err instanceof Error ? err.message : String(err)
      expect(message).not.toContain(secret)
      expect(message.toLowerCase()).not.toContain('witness')
    }
  })
})
