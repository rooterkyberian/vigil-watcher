export class WakeLockKeeper {
  private sentinel: WakeLockSentinel | null = null
  private wanted = false
  private listening = false

  get supported(): boolean {
    return 'wakeLock' in navigator
  }

  get held(): boolean {
    return this.sentinel !== null && !this.sentinel.released
  }

  async acquire(): Promise<boolean> {
    this.wanted = true
    this.listen()
    return this.request()
  }

  async release(): Promise<void> {
    this.wanted = false
    const sentinel = this.sentinel
    this.sentinel = null
    if (sentinel !== null) await sentinel.release().catch(() => undefined)
  }

  private async request(): Promise<boolean> {
    if (!this.supported || !this.wanted || document.visibilityState !== 'visible') return false
    if (this.held) return true
    try {
      this.sentinel = await navigator.wakeLock.request('screen')
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null
      })
      return true
    } catch {
      this.sentinel = null
      return false
    }
  }

  private listen(): void {
    if (this.listening) return
    this.listening = true
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.request()
    })
  }
}
