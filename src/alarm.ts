import { ALARM_TEST_MS, type AlarmStyle } from './config'

export class Alarm {
  private context: AudioContext | null = null
  private oscillator: OscillatorNode | null = null
  private gain: GainNode | null = null
  private swapTimer: number | null = null
  private vibrateTimer: number | null = null
  private high = false
  private running = false

  constructor(
    private readonly flashTarget: HTMLElement,
    private style: AlarmStyle,
  ) {}

  setStyle(style: AlarmStyle): void {
    this.style = style
    if (this.running) {
      this.stopTone()
      this.startTone()
    }
  }

  get ready(): boolean {
    return this.context !== null && this.context.state === 'running'
  }

  async unlock(): Promise<void> {
    if (this.context === null) this.context = new AudioContext()
    if (this.context.state === 'suspended') await this.context.resume()

    const primer = this.context.createBuffer(1, 1, this.context.sampleRate)
    const source = this.context.createBufferSource()
    source.buffer = primer
    source.connect(this.context.destination)
    source.start()
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.flashTarget.dataset.alarm = reducedMotion() ? 'static' : 'flash'
    this.startTone()
    this.startVibration()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    delete this.flashTarget.dataset.alarm
    this.stopTone()
    this.stopVibration()
  }

  async test(): Promise<void> {
    await this.unlock()
    this.start()
    await new Promise((resolve) => window.setTimeout(resolve, ALARM_TEST_MS))
    this.stop()
  }

  private startTone(): void {
    const context = this.context
    if (context === null) return
    void context.resume()

    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = this.style.waveform
    oscillator.frequency.setValueAtTime(this.style.toneAHz, context.currentTime)
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start()

    this.oscillator = oscillator
    this.gain = gain
    this.high = false
    this.pulse()
    this.swapTimer = window.setInterval(() => this.pulse(), this.style.swapMs)
  }

  private pulse(): void {
    const context = this.context
    if (context === null || this.oscillator === null || this.gain === null) return
    const now = context.currentTime
    this.high = !this.high
    this.oscillator.frequency.setValueAtTime(this.high ? this.style.toneBHz : this.style.toneAHz, now)
    const seconds = this.style.swapMs / 1000
    const peak = this.style.gain
    this.gain.gain.cancelScheduledValues(now)
    this.gain.gain.setValueAtTime(0.0001, now)
    this.gain.gain.exponentialRampToValueAtTime(peak, now + seconds * 0.12)
    this.gain.gain.setValueAtTime(peak, now + seconds * 0.7)
    this.gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds * 0.95)
  }

  private stopTone(): void {
    if (this.swapTimer !== null) window.clearInterval(this.swapTimer)
    this.swapTimer = null
    if (this.oscillator !== null) {
      try {
        this.oscillator.stop()
      } catch {
        /* already stopped */
      }
      this.oscillator.disconnect()
    }
    this.gain?.disconnect()
    this.oscillator = null
    this.gain = null
  }

  private startVibration(): void {
    const pattern = this.style.vibrate
    if (pattern === null || typeof navigator.vibrate !== 'function') return
    const period = pattern.reduce((total, part) => total + part, 0) + 160
    const fire = (): void => {
      navigator.vibrate([...pattern])
    }
    fire()
    this.vibrateTimer = window.setInterval(fire, period)
  }

  private stopVibration(): void {
    if (this.vibrateTimer !== null) window.clearInterval(this.vibrateTimer)
    this.vibrateTimer = null
    if (typeof navigator.vibrate === 'function') navigator.vibrate(0)
  }
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
