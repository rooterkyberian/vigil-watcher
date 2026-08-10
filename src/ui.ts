import type { ProfileId } from './config'
import type { AlertLevel, DataState } from './core/types'

export type Screen = 'standby' | 'calibrating' | 'running'

export interface MetricView {
  perclos: string
  blinks: string
  nod: string
}

export interface CalibrationView {
  title: string
  body: string
  progress: number
  countdown: string
}

function required<T extends Element>(id: string): T {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`missing element #${id}`)
  return element as unknown as T
}

export class Ui {
  readonly app = required<HTMLDivElement>('app')
  readonly video = required<HTMLVideoElement>('preview')
  readonly canvas = required<HTMLCanvasElement>('trace')

  private readonly status = required<HTMLElement>('status')
  private readonly statusLevel = required<HTMLParagraphElement>('statusLevel')
  private readonly statusReason = required<HTMLParagraphElement>('statusReason')
  private readonly metricPerclos = required<HTMLParagraphElement>('metricPerclos')
  private readonly metricBlinks = required<HTMLParagraphElement>('metricBlinks')
  private readonly metricNod = required<HTMLParagraphElement>('metricNod')
  private readonly previewLabel = required<HTMLParagraphElement>('previewLabel')
  private readonly engineLabel = required<HTMLSpanElement>('engineLabel')
  private readonly closureSlider = required<HTMLInputElement>('closureSlider')
  private readonly closureValue = required<HTMLElement>('closureValue')

  private readonly startButton = required<HTMLButtonElement>('startButton')
  private readonly stopButton = required<HTMLButtonElement>('stopButton')
  private readonly calibrateButton = required<HTMLButtonElement>('calibrateButton')
  private readonly testAlarmButton = required<HTMLButtonElement>('testAlarmButton')
  private readonly dismissButton = required<HTMLButtonElement>('dismissButton')

  private readonly modeVigilant = required<HTMLButtonElement>('modeVigilant')
  private readonly modeCouch = required<HTMLButtonElement>('modeCouch')
  private readonly modeBlurb = required<HTMLParagraphElement>('modeBlurb')

  private readonly banner = required<HTMLDivElement>('banner')
  private readonly bannerMessage = required<HTMLParagraphElement>('bannerMessage')
  private readonly bannerHint = required<HTMLParagraphElement>('bannerHint')
  private readonly bannerClose = required<HTMLButtonElement>('bannerClose')

  private readonly calibrationOverlay = required<HTMLDivElement>('calibrationOverlay')
  private readonly calibrationTitle = required<HTMLHeadingElement>('calibrationTitle')
  private readonly calibrationBody = required<HTMLParagraphElement>('calibrationBody')
  private readonly calibrationProgress = required<HTMLDivElement>('calibrationProgress')
  private readonly calibrationCount = required<HTMLParagraphElement>('calibrationCount')
  private readonly calibrationCancel = required<HTMLButtonElement>('calibrationCancel')

  private readonly confirmOverlay = required<HTMLDivElement>('confirmOverlay')
  private readonly confirmAllow = required<HTMLButtonElement>('confirmAllow')
  private readonly confirmDeny = required<HTMLButtonElement>('confirmDeny')

  constructor() {
    this.bannerClose.addEventListener('click', () => this.hideBanner())
  }

  setScreen(screen: Screen): void {
    this.app.dataset.screen = screen
    this.startButton.hidden = screen === 'running'
    this.stopButton.hidden = screen !== 'running'
    this.calibrationOverlay.hidden = screen !== 'calibrating'
  }

  setStatus(level: AlertLevel, dataState: DataState, headline: string, reason: string): void {
    this.status.dataset.level = level
    this.status.dataset.state = dataState
    this.statusLevel.textContent = headline
    this.statusReason.textContent = reason
  }

  setMetrics(view: MetricView): void {
    this.metricPerclos.textContent = view.perclos
    this.metricBlinks.textContent = view.blinks
    this.metricNod.textContent = view.nod
  }

  setPreviewLabel(text: string): void {
    this.previewLabel.textContent = text
  }

  setEngineLabel(text: string): void {
    this.engineLabel.textContent = text
  }

  setClosurePoint(value: number): void {
    this.closureSlider.value = value.toFixed(2)
    this.closureValue.textContent = value.toFixed(2)
  }

  setProfile(profile: ProfileId, label: string, blurb: string): void {
    this.modeVigilant.setAttribute('aria-checked', String(profile === 'vigilant'))
    this.modeCouch.setAttribute('aria-checked', String(profile === 'couch'))
    this.modeBlurb.textContent = `${label} — ${blurb}`
  }

  setCalibrationView(view: CalibrationView): void {
    this.calibrationTitle.textContent = view.title
    this.calibrationBody.textContent = view.body
    this.calibrationProgress.style.width = `${Math.round(view.progress * 100)}%`
    this.calibrationCount.textContent = view.countdown
  }

  showDismiss(visible: boolean): void {
    this.dismissButton.hidden = !visible
  }

  setBusy(busy: boolean): void {
    this.startButton.disabled = busy
    this.calibrateButton.disabled = busy
    this.testAlarmButton.disabled = busy
  }

  showBanner(message: string, hint: string): void {
    this.bannerMessage.textContent = message
    this.bannerHint.textContent = hint
    this.banner.hidden = false
  }

  hideBanner(): void {
    this.banner.hidden = true
  }

  confirmRemoteFetch(): Promise<boolean> {
    this.confirmOverlay.hidden = false
    return new Promise<boolean>((resolve) => {
      const settle = (allowed: boolean) => (): void => {
        this.confirmOverlay.hidden = true
        this.confirmAllow.removeEventListener('click', allow)
        this.confirmDeny.removeEventListener('click', deny)
        resolve(allowed)
      }
      const allow = settle(true)
      const deny = settle(false)
      this.confirmAllow.addEventListener('click', allow)
      this.confirmDeny.addEventListener('click', deny)
    })
  }

  onStart(handler: () => void): void {
    this.startButton.addEventListener('click', handler)
  }
  onStop(handler: () => void): void {
    this.stopButton.addEventListener('click', handler)
  }
  onCalibrate(handler: () => void): void {
    this.calibrateButton.addEventListener('click', handler)
  }
  onTestAlarm(handler: () => void): void {
    this.testAlarmButton.addEventListener('click', handler)
  }
  onDismiss(handler: () => void): void {
    this.dismissButton.addEventListener('click', handler)
  }
  onCancelCalibration(handler: () => void): void {
    this.calibrationCancel.addEventListener('click', handler)
  }
  onProfile(handler: (profile: ProfileId) => void): void {
    this.modeVigilant.addEventListener('click', () => handler('vigilant'))
    this.modeCouch.addEventListener('click', () => handler('couch'))
  }
  onClosurePoint(handler: (value: number) => void): void {
    this.closureSlider.addEventListener('input', () => {
      const value = Number(this.closureSlider.value)
      this.closureValue.textContent = value.toFixed(2)
      handler(value)
    })
  }
}
