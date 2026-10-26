import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_SPEECH_SETTINGS,
  type SpeechErrorCode,
  type SpeechRuntimeStatus,
  type SpeechSettings
} from '../../../../shared/speech'

export function useSpeechSettings(active: boolean): {
  settings: SpeechSettings
  setSettings: (settings: SpeechSettings) => void
  runtime: SpeechRuntimeStatus | null
  error: SpeechErrorCode | null
  pending: boolean
  loaded: boolean
  saved: boolean
  save: () => Promise<void>
  install: () => Promise<void>
  cancelInstall: () => Promise<void>
} {
  const [settings, setSettings] = useState<SpeechSettings>(DEFAULT_SPEECH_SETTINGS)
  const [runtime, setRuntime] = useState<SpeechRuntimeStatus | null>(null)
  const [error, setError] = useState<SpeechErrorCode | null>(null)
  const [pending, setPending] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!active) return
    let cancelled = false
    let events = 0
    const detach = window.api.speech.onStatus((state) => {
      events++
      setRuntime(state)
    })
    void Promise.all([window.api.speech.getSettings(), window.api.speech.getRuntimeStatus()])
      .then(([config, status]) => {
        if (cancelled) return
        if (config.status === 'ok') {
          setSettings(config.settings)
          setLoaded(true)
        } else setError(config.error.code)
        if (status.status === 'ok') {
          if (!events) setRuntime(status.runtime)
        } else setError(status.error.code)
      })
      .catch(() => {
        if (!cancelled) setError('SETTINGS_FAILED')
      })
    return () => {
      cancelled = true
      detach()
    }
  }, [active])
  const save = useCallback(async (): Promise<void> => {
    setPending(true)
    setError(null)
    setSaved(false)
    try {
      const result = await window.api.speech.updateSettings(settings)
      if (!mounted.current) return
      if (result.status === 'ok') {
        setSettings(result.settings)
        setSaved(true)
      } else setError(result.error.code)
    } catch {
      if (mounted.current) setError('SETTINGS_FAILED')
    } finally {
      if (mounted.current) setPending(false)
    }
  }, [settings])
  const install = useCallback(async (): Promise<void> => {
    setPending(true)
    setError(null)
    setSaved(false)
    try {
      const result = await window.api.speech.installResources()
      if (mounted.current && result.status === 'error') setError(result.error.code)
    } catch {
      if (mounted.current) setError('INSTALL_FAILED')
    } finally {
      if (mounted.current) setPending(false)
    }
  }, [])
  const cancelInstall = useCallback(async (): Promise<void> => {
    try {
      const result = await window.api.speech.cancelInstall()
      if (mounted.current && result.status === 'error') setError(result.error.code)
    } catch {
      if (mounted.current) setError('INSTALL_FAILED')
    }
  }, [])
  return {
    settings,
    setSettings: (value) => {
      setSettings(value)
      setSaved(false)
    },
    runtime,
    error,
    pending,
    loaded,
    saved,
    save,
    install,
    cancelInstall
  }
}
