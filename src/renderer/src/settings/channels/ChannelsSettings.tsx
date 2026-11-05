import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  CommunicationApi,
  CommunicationErrorCode,
  CommunicationSnapshot
} from '../../../../shared/communication'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { ChannelTokenDialog } from './ChannelTokenDialog'
import './ChannelsSettings.css'

type Connection = CommunicationSnapshot['connections'][number]
type ActionResult = Awaited<ReturnType<CommunicationApi['testConnection']>>
type Dialog =
  | { kind: 'add' }
  | { kind: 'edit' | 'delete'; connection: Connection }
  | { kind: 'test'; connection: Connection; outcome?: ActionResult }

export function ChannelsSettings({ active }: { active: boolean }): React.JSX.Element | null {
  return active ? <ActiveChannelsSettings /> : null
}

function ActiveChannelsSettings(): React.JSX.Element {
  const { t, i18n } = useTranslation('communication')
  const [snapshot, setSnapshot] = useState<CommunicationSnapshot>()
  const [loadFailed, setLoadFailed] = useState(false)
  const [dialog, setDialog] = useState<Dialog>()
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<CommunicationErrorCode>()
  const [testing, setTesting] = useState<ReadonlySet<string>>(() => new Set())
  const addButton = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement>(null)
  const loadVersion = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    const version = ++loadVersion.current
    try {
      const result = await window.api.communication.snapshot()
      if (version !== loadVersion.current) return
      if (result.status === 'ok') {
        setSnapshot(result.snapshot)
        setLoadFailed(false)
      } else setLoadFailed(true)
    } catch {
      if (version === loadVersion.current) setLoadFailed(true)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => void reload(), 0)
    return () => {
      clearTimeout(timer)
    }
  }, [reload])

  const open = (next: Dialog, trigger: HTMLButtonElement): void => {
    returnFocusRef.current = trigger
    setDeleteError(undefined)
    setDialog(next)
  }
  const close = (): void => setDialog(undefined)

  const testConnection = async (
    connection: Connection,
    trigger: HTMLButtonElement
  ): Promise<void> => {
    const pending = { kind: 'test', connection } as const
    setTesting((current) => new Set(current).add(connection.id))
    open(pending, trigger)
    let outcome: ActionResult
    try {
      outcome = await window.api.communication.testConnection({ connectionId: connection.id })
    } catch {
      outcome = { status: 'error', error: { code: 'COMMUNICATION_FAILED' } }
    }
    setTesting((current) => {
      const next = new Set(current)
      next.delete(connection.id)
      return next
    })
    setDialog((current) => (current === pending ? { ...pending, outcome } : current))
  }

  const saveToken = async (token: string): Promise<ActionResult> => {
    const result =
      dialog?.kind === 'edit'
        ? await window.api.communication.setCredential({
            connectionId: dialog.connection.id,
            credential: token
          })
        : await window.api.communication.createTelegramConnection({ token })
    if (result.status === 'ok') await reload()
    return result
  }

  const deleteConnection = async (connection: Connection): Promise<void> => {
    setDeleting(true)
    setDeleteError(undefined)
    try {
      const result = await window.api.communication.deleteConnection({
        connectionId: connection.id
      })
      if (result.status === 'ok') {
        returnFocusRef.current = addButton.current
        await reload()
        close()
      } else {
        setDeleteError(result.error.code)
        await reload()
      }
    } catch {
      setDeleteError('COMMUNICATION_FAILED')
      await reload()
    } finally {
      setDeleting(false)
    }
  }

  const channelName = (connection: Connection): string => {
    const adapter =
      connection.adapterId === 'telegram' ? t('adapters.telegram') : connection.adapterId
    return connection.username
      ? t('channelName', { adapter, username: connection.username })
      : adapter
  }
  const connections = snapshot?.connections
    .slice()
    .sort((a, b) => (b.createdAt ?? -1) - (a.createdAt ?? -1))
  const dateFormat = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
    timeStyle: 'short'
  })

  return (
    <div className="channels-settings">
      <button
        className="channel-add-button"
        ref={addButton}
        type="button"
        onClick={(event) => open({ kind: 'add' }, event.currentTarget)}
        disabled={!snapshot}
      >
        {t('addChannel')}
      </button>
      {loadFailed && (
        <div className="channel-actions">
          <p className="settings-error" role="alert">
            {t('loadFailed')}
          </p>
          <button type="button" onClick={() => void reload()}>
            {t('retryLoad')}
          </button>
        </div>
      )}
      {connections?.map((connection) => {
        const headingId = `channel-${connection.id}`
        const added =
          connection.createdAt === undefined ? undefined : new Date(connection.createdAt)
        return (
          <article className="channel-card" key={connection.id} aria-labelledby={headingId}>
            <h3 id={headingId}>{channelName(connection)}</h3>
            <p className="channel-added-at">
              {added ? (
                <time dateTime={added.toISOString()}>
                  {t('addedAt', { date: dateFormat.format(added) })}
                </time>
              ) : (
                t('addedAtUnknown')
              )}
            </p>
            <div className="channel-actions">
              <button
                type="button"
                disabled={connection.deleting || connection.adapterId !== 'telegram'}
                aria-disabled={testing.has(connection.id) || undefined}
                onClick={(event) => {
                  if (!testing.has(connection.id))
                    void testConnection(connection, event.currentTarget)
                }}
              >
                {t('testConnection')}
              </button>
              <button
                type="button"
                disabled={connection.deleting || connection.adapterId !== 'telegram'}
                onClick={(event) => open({ kind: 'edit', connection }, event.currentTarget)}
              >
                {t('editToken')}
              </button>
              <button
                type="button"
                className="channel-delete-button"
                onClick={(event) => open({ kind: 'delete', connection }, event.currentTarget)}
              >
                {t('deleteChannel')}
              </button>
            </div>
          </article>
        )
      })}
      {(dialog?.kind === 'add' || dialog?.kind === 'edit') && snapshot && (
        <ChannelTokenDialog
          editing={dialog.kind === 'edit'}
          installedAdapters={snapshot.installedAdapters}
          onClose={close}
          onSave={saveToken}
          returnFocusRef={returnFocusRef}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          open
          title={t('deleteChannel')}
          description={t('deletePrompt')}
          cancelLabel={t('cancelForm')}
          confirmLabel={t('confirmDelete')}
          tone="danger"
          busy={deleting}
          error={deleteError ? t(`errors.${deleteError}`) : undefined}
          onCancel={close}
          onConfirm={() => void deleteConnection(dialog.connection)}
          returnFocusRef={returnFocusRef}
        >
          <p className="confirm-text">{channelName(dialog.connection)}</p>
        </ConfirmDialog>
      )}
      {dialog?.kind === 'test' && (
        <ConfirmDialog
          open
          title={t('testTitle')}
          description={channelName(dialog.connection)}
          confirmLabel={t('closeDialog')}
          onCancel={close}
          onConfirm={close}
          returnFocusRef={returnFocusRef}
        >
          <p className="confirm-text" role="status">
            {dialog.outcome === undefined
              ? t('testRunning')
              : dialog.outcome.status === 'ok'
                ? t('testSuccess')
                : t(`errors.${dialog.outcome.error.code}`)}
          </p>
        </ConfirmDialog>
      )}
    </div>
  )
}
