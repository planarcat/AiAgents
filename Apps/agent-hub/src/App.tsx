import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  Bot,
  Check,
  KeyRound,
  Loader2,
  Plus,
  Save,
  Send,
  Settings2,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

type AgentSummary = {
  id: string
  display_name: string
  allows_outgoing_delegation: boolean
  accepts_incoming_delegation: boolean
}

type AgentDetail = {
  id: string
  display_name: string
  system_prompt: string
  allows_outgoing_delegation: boolean
  accepts_incoming_delegation: boolean
}

type ChatMessage = {
  id: string
  role: string
  content: string
}

type ConversationState = {
  conversation_id: string
  llm_preset_id: string
}

const PRESET_DEEPSEEK = 'deepseek_default'

const PRESET_LABEL: Record<string, string> = {
  [PRESET_DEEPSEEK]: 'DeepSeek',
}

const REPLY_PHASE_LABEL: Record<string, string> = {
  thinking: '正在思考…',
  analyzing: '正在分析上下文…',
  tools: '正在调用工具…',
  generating: '正在生成回复…',
}

export default function App() {
  const [loading, setLoading] = useState(true)
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [apiKeyOk, setApiKeyOk] = useState(false)

  const [keyOpen, setKeyOpen] = useState(false)
  const [keyTargetPreset, setKeyTargetPreset] = useState(PRESET_DEEPSEEK)
  const [keyInput, setKeyInput] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [replyPhase, setReplyPhase] = useState<string>('idle')

  const [conv, setConv] = useState<ConversationState | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [convLoading, setConvLoading] = useState(false)
  const [input, setInput] = useState('')
  const [sendBusy, setSendBusy] = useState(false)

  /** 助手管理：创建 / 编辑 / 删除 / 快速创建（默认模板）/ 导入 均在此弹窗内 */
  const [managerOpen, setManagerOpen] = useState(false)
  const [managerBusy, setManagerBusy] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formName, setFormName] = useState('')
  const [formPrompt, setFormPrompt] = useState('')
  const [formOutgoing, setFormOutgoing] = useState(true)
  const [formIncoming, setFormIncoming] = useState(true)

  const importRef = useRef<HTMLInputElement>(null)
  const msgEndRef = useRef<HTMLDivElement>(null)
  const convIdRef = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await invoke<AgentSummary[]>('agents_list')
      setAgents(list)
      setSelectedId((cur) => {
        if (list.length === 0) return null
        if (cur && list.some((a) => a.id === cur)) return cur
        return list[0]!.id
      })
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshKeyOnly = useCallback(async (presetId: string) => {
    const configured = await invoke<boolean>('settings_llm_key_configured', { presetId })
    setApiKeyOk(configured)
    return configured
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    convIdRef.current = conv?.conversation_id ?? null
  }, [conv?.conversation_id])

  const activeKeyPreset = conv?.llm_preset_id ?? PRESET_DEEPSEEK

  useEffect(() => {
    void refreshKeyOnly(activeKeyPreset)
  }, [activeKeyPreset, refreshKeyOnly])

  useEffect(() => {
    if (keyOpen) {
      setKeyTargetPreset(activeKeyPreset)
    }
  }, [keyOpen, activeKeyPreset])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void listen<{ conversation_id: string; phase: string }>('chat_reply_phase', (event) => {
      if (cancelled) return
      if (event.payload.conversation_id === convIdRef.current) {
        setReplyPhase(event.payload.phase)
      }
    }).then((fn) => {
      if (!cancelled) unlisten = fn
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const resetManagerCreate = useCallback(() => {
    setEditingId(null)
    setFormName('')
    setFormPrompt('')
    setFormOutgoing(true)
    setFormIncoming(true)
  }, [])

  const loadAgentIntoForm = useCallback(async (id: string) => {
    setManagerBusy(true)
    try {
      const d = await invoke<AgentDetail>('agents_get', { id })
      setEditingId(d.id)
      setFormName(d.display_name)
      setFormPrompt(d.system_prompt)
      setFormOutgoing(d.allows_outgoing_delegation)
      setFormIncoming(d.accepts_incoming_delegation)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setManagerBusy(false)
    }
  }, [])

  const openManager = useCallback(() => {
    resetManagerCreate()
    setManagerOpen(true)
  }, [resetManagerCreate])

  const loadThread = useCallback(async (agentId: string) => {
    setConvLoading(true)
    try {
      const c = await invoke<ConversationState>('conversations_ensure', { agentId })
      setConv(c)
      const m = await invoke<ChatMessage[]>('messages_list', { conversationId: c.conversation_id })
      setMessages(m)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
      setConv(null)
      setMessages([])
    } finally {
      setConvLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!selectedId) {
      setConv(null)
      setMessages([])
      return
    }
    void loadThread(selectedId)
  }, [selectedId, loadThread])

  useEffect(() => {
    msgEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, convLoading, sendBusy, replyPhase])

  const selected = agents.find((a) => a.id === selectedId) ?? null

  async function onSaveKey() {
    setKeyBusy(true)
    try {
      await invoke('settings_save_llm_key', { presetId: keyTargetPreset, key: keyInput })
      setKeyInput('')
      setKeyOpen(false)
      const ok = await refreshKeyOnly(keyTargetPreset)
      if (!ok) {
        window.alert('密钥已写入，但本机读取校验未通过。若无法对话，请检查系统凭据权限或稍后重试。')
      }
      await refreshKeyOnly(activeKeyPreset)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setKeyBusy(false)
    }
  }

  async function onClearKey() {
    setKeyBusy(true)
    try {
      await invoke('settings_clear_llm_key', { presetId: keyTargetPreset })
      await refreshKeyOnly(activeKeyPreset)
      setKeyOpen(false)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setKeyBusy(false)
    }
  }

  async function onPresetChange(preset: string) {
    if (!conv) return
    try {
      await invoke('conversations_set_llm_preset', {
        conversationId: conv.conversation_id,
        llmPresetId: preset,
      })
      setConv({ ...conv, llm_preset_id: preset })
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }

  async function onSend() {
    const t = input.trim()
    if (!t || !conv) return
    const preset = conv.llm_preset_id
    const ok = await refreshKeyOnly(preset)
    if (!ok) {
      window.alert(
        `尚未配置「${PRESET_LABEL[preset] ?? preset}」的 API 密钥。请点击右上角密钥图标，为该大模型保存密钥。`,
      )
      return
    }
    const optimisticId = `optimistic-${Date.now()}`
    setMessages((prev) => [...prev, { id: optimisticId, role: 'user', content: t }])
    setInput('')
    setReplyPhase('thinking')
    setSendBusy(true)
    try {
      await invoke<string>('chat_send', {
        conversationId: conv.conversation_id,
        userText: t,
      })
      const m = await invoke<ChatMessage[]>('messages_list', { conversationId: conv.conversation_id })
      setMessages(m)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
      try {
        const m = await invoke<ChatMessage[]>('messages_list', { conversationId: conv.conversation_id })
        setMessages(m)
      } catch {
        setMessages((prev) => prev.filter((x) => x.id !== optimisticId))
      }
    } finally {
      setSendBusy(false)
      setReplyPhase('idle')
    }
  }

  async function onManagerSave() {
    const name = formName.trim()
    if (!name) {
      window.alert('请填写助手名称')
      return
    }
    setManagerBusy(true)
    try {
      if (editingId) {
        await invoke('agents_update', {
          id: editingId,
          displayName: formName,
          systemPrompt: formPrompt,
          allowsOutgoingDelegation: formOutgoing,
          acceptsIncomingDelegation: formIncoming,
        })
      } else {
        await invoke('agents_create', {
          displayName: formName,
          systemPrompt: formPrompt,
        })
      }
      await refresh()
      setManagerOpen(false)
      resetManagerCreate()
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setManagerBusy(false)
    }
  }

  async function onManagerDefaultTemplate() {
    setManagerBusy(true)
    try {
      await invoke<string>('agents_create_default_template')
      await refresh()
      setManagerOpen(false)
      resetManagerCreate()
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setManagerBusy(false)
    }
  }

  async function onManagerDelete() {
    if (!editingId) return
    if (!window.confirm('确定删除当前助手？此操作不可撤销。')) return
    setManagerBusy(true)
    try {
      await invoke('agents_delete', { id: editingId })
      if (selectedId === editingId) setSelectedId(null)
      setManagerOpen(false)
      resetManagerCreate()
      await refresh()
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setManagerBusy(false)
    }
  }

  async function onImportFile(f: FileList | null) {
    const file = f?.[0]
    if (!file) return
    setManagerBusy(true)
    try {
      const text = await file.text()
      const n = await invoke<number>('agents_import_bulk', { json: text })
      window.alert(`已导入 ${n} 位助手`)
      await refresh()
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setManagerBusy(false)
      if (importRef.current) importRef.current.value = ''
    }
  }

  const phaseLabel =
    sendBusy && replyPhase !== 'idle' ? REPLY_PHASE_LABEL[replyPhase] ?? '正在处理…' : null

  const mainViewKey = !selected && !loading ? 'empty' : (selectedId ?? 'loading')

  return (
    <div className="flex h-[100dvh] max-h-[100dvh] flex-col overflow-hidden bg-background bg-[radial-gradient(ellipse_100%_60%_at_50%_-15%,hsl(var(--primary)/0.09),transparent)] text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border/80 bg-card/75 px-5 shadow-sm backdrop-blur-md transition-[box-shadow,background-color] duration-300 supports-[backdrop-filter]:bg-card/50 md:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors duration-200">
            <Bot className="size-5" aria-hidden />
          </div>
          <span className="truncate text-base font-semibold tracking-tight">智能助手</span>
        </div>
        <div className="relative shrink-0">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="rounded-lg"
            title="大模型密钥（各密钥独立保存）"
            aria-label="大模型密钥"
            onClick={() => setKeyOpen(true)}
          >
            <KeyRound className="size-4" aria-hidden />
          </Button>
          <span
            className={cn(
              'pointer-events-none absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-background transition-colors duration-300',
              apiKeyOk ? 'bg-emerald-500' : 'bg-muted-foreground/70',
            )}
            aria-hidden
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="flex w-[260px] shrink-0 flex-col gap-4 overflow-hidden border-r border-border/80 bg-card/35 p-4 transition-colors duration-200">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground px-0.5">
            对话对象
          </p>
          <ScrollArea className="flex-1 min-h-[120px] -mx-1">
            <div className="space-y-1 pr-2">
              {loading
                ? Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full rounded-md" />
                  ))
                : agents.length === 0
                  ? (
                      <p className="text-xs text-muted-foreground leading-relaxed py-2 px-0.5">
                        暂无助手。点击下方「助手与数据」创建。
                      </p>
                    )
                  : (
                      agents.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => setSelectedId(a.id)}
                          className={cn(
                            'w-full rounded-lg border px-3 py-2.5 text-left text-sm transition-all duration-200 ease-out active:scale-[0.99] motion-reduce:active:scale-100',
                            selectedId === a.id
                              ? 'border-primary/40 bg-primary/10 font-medium text-foreground shadow-sm ring-1 ring-primary/15'
                              : 'border-transparent bg-background/60 hover:border-border hover:bg-muted/70',
                          )}
                        >
                          {a.display_name}
                        </button>
                      ))
                    )}
            </div>
          </ScrollArea>
          <Separator />
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="w-full shrink-0 rounded-lg"
            title="助手与数据"
            aria-label="助手与数据"
            onClick={() => void openManager()}
          >
            <Settings2 className="size-4" aria-hidden />
          </Button>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-5 md:p-6 lg:px-8 lg:pb-8">
          <div
            key={mainViewKey}
            className="flex min-h-0 flex-1 flex-col overflow-hidden motion-reduce:animate-none animate-in fade-in-0 zoom-in-[0.99] slide-in-from-bottom-1 duration-300 ease-out"
          >
          {!selected && !loading ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-6 max-w-md mx-auto w-full">
              <Card className="w-full border-dashed border-border/80 bg-card/60 shadow-none backdrop-blur-sm transition-[box-shadow,transform] duration-300 hover:shadow-md motion-reduce:transition-none">
                <CardHeader className="pb-6">
                  <CardTitle className="text-lg">开始对话</CardTitle>
                  <CardDescription className="leading-relaxed">请选择一位助手以开始对话。</CardDescription>
                </CardHeader>
              </Card>
            </div>
          ) : (
            <Card className="flex min-h-0 flex-1 flex-col overflow-hidden border-border/80 shadow-md transition-shadow duration-300">
              <CardHeader className="shrink-0 space-y-2 border-b border-border/60 bg-muted/25 py-4 transition-colors duration-200">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle
                    key={selectedId ?? 'title'}
                    className="text-base motion-reduce:animate-none animate-in fade-in-0 duration-200"
                  >
                    {selected ? selected.display_name : '…'}
                  </CardTitle>
                  <div className="flex items-center gap-2 text-sm">
                    <Label htmlFor="llm-preset" className="shrink-0 text-muted-foreground">
                      大模型
                    </Label>
                    <select
                      id="llm-preset"
                      className="h-9 min-w-[9.5rem] rounded-md border border-input bg-background px-3 text-sm shadow-sm ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                      value={conv?.llm_preset_id ?? PRESET_DEEPSEEK}
                      disabled={!conv || convLoading}
                      onChange={(e) => void onPresetChange(e.target.value)}
                    >
                      <option value={PRESET_DEEPSEEK}>DeepSeek</option>
                    </select>
                  </div>
                </div>
                {!apiKeyOk ? (
                  <p className="text-sm text-muted-foreground">请先在右上角配置当前大模型对应的密钥后再发送。</p>
                ) : null}
              </CardHeader>
              <CardContent className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden bg-card/30 pt-5">
                {!apiKeyOk ? (
                  <div className="motion-reduce:animate-none animate-in fade-in-0 slide-in-from-top-1 duration-200 rounded-xl border border-amber-200/80 bg-amber-50/90 px-4 py-3 text-sm text-amber-950 shadow-sm dark:border-amber-900/45 dark:bg-amber-950/40 dark:text-amber-50">
                    尚未检测到可用密钥。请点击右上角「大模型密钥」保存（与 DeepSeek OpenAI 兼容接口一致）。
                  </div>
                ) : null}
                <ScrollArea className="min-h-0 flex-1 rounded-xl border border-border/60 bg-muted/15 shadow-inner">
                  <div className="space-y-3 p-4 md:p-5">
                    {convLoading ? (
                      <>
                        <Skeleton className="h-12 w-[72%] rounded-2xl" />
                        <Skeleton className="ml-auto h-12 w-[64%] rounded-2xl" />
                      </>
                    ) : messages.length === 0 && !sendBusy ? (
                      <p className="py-14 text-center text-sm text-muted-foreground">还没有消息。</p>
                    ) : (
                      messages.map((m) => (
                        <div
                          key={m.id}
                          className={cn(
                            'max-w-[min(85%,36rem)] motion-reduce:animate-none animate-enter rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words shadow-sm',
                            m.role === 'user'
                              ? 'ml-auto bg-primary text-primary-foreground'
                              : 'mr-auto border border-border/60 bg-card text-card-foreground',
                          )}
                        >
                          {m.content}
                        </div>
                      ))
                    )}
                    {sendBusy && phaseLabel ? (
                      <div className="motion-reduce:animate-none animate-enter-subtle mr-auto flex max-w-[min(85%,36rem)] items-center gap-2 rounded-2xl border border-dashed border-primary/30 bg-primary/5 px-3.5 py-2.5 text-sm text-muted-foreground">
                        <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
                        <span>{phaseLabel}</span>
                      </div>
                    ) : null}
                    <div ref={msgEndRef} />
                  </div>
                </ScrollArea>
                <div className="flex shrink-0 items-end gap-3">
                  <Textarea
                    placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    disabled={sendBusy || convLoading}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        void onSend()
                      }
                    }}
                    className="min-h-[80px] flex-1 resize-none rounded-xl border-border/80 bg-background/80 transition-[border-color,box-shadow] duration-200"
                  />
                  <Button
                    type="button"
                    size="icon"
                    className="size-11 shrink-0 rounded-xl"
                    title="发送"
                    aria-label="发送"
                    disabled={sendBusy || convLoading || !input.trim()}
                    onClick={() => void onSend()}
                  >
                    {sendBusy ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                      <Send className="size-4" aria-hidden />
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
          </div>
        </main>
      </div>

      <Dialog
        open={keyOpen}
        onOpenChange={(open) => {
          setKeyOpen(open)
          if (!open) void refreshKeyOnly(activeKeyPreset)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>大模型密钥</DialogTitle>
            <DialogDescription>
              在下方填入 API Key，API Key保存在本机系统中，同一个大模型已有的API Key将被新的覆盖。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="key-preset">大模型</Label>
              <select
                id="key-preset"
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={keyTargetPreset}
                disabled={keyBusy}
                onChange={(e) => setKeyTargetPreset(e.target.value)}
              >
                <option value={PRESET_DEEPSEEK}>DeepSeek（OpenAI 兼容）</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="api-key">API 密钥</Label>
              <Input
                id="api-key"
                type="password"
                autoComplete="off"
                placeholder="粘贴密钥"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:gap-0">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="rounded-lg sm:mr-auto"
              title="清除该大模型已保存的密钥"
              aria-label="清除该大模型已保存的密钥"
              onClick={() => void onClearKey()}
              disabled={keyBusy}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
            <Button
              type="button"
              size="icon"
              className="rounded-lg"
              title="保存密钥"
              aria-label="保存密钥"
              onClick={() => void onSaveKey()}
              disabled={keyBusy || !keyInput.trim()}
            >
              {keyBusy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Save className="size-4" aria-hidden />}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={managerOpen}
        onOpenChange={(o) => {
          setManagerOpen(o)
          if (!o) resetManagerCreate()
        }}
      >
        <DialogContent className="sm:max-w-lg max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>助手与数据</DialogTitle>
          </DialogHeader>

          <div className="flex flex-wrap gap-2 shrink-0">
            <Button
              type="button"
              size="icon"
              variant={editingId === null ? 'default' : 'outline'}
              className="rounded-lg"
              title="创建助手"
              aria-label="创建助手"
              onClick={() => resetManagerCreate()}
            >
              <Plus className="size-4" aria-hidden />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="rounded-lg"
              title="导入 JSON"
              aria-label="导入 JSON"
              onClick={() => importRef.current?.click()}
            >
              <Upload className="size-4" aria-hidden />
            </Button>
            <input
              ref={importRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(ev) => void onImportFile(ev.target.files)}
            />
          </div>

          {agents.length > 0 ? (
            <div className="space-y-1 shrink-0">
              <Label className="text-xs text-muted-foreground">已有助手</Label>
              <ScrollArea className="h-[100px] rounded-md border p-1">
                <div className="flex flex-col gap-1 pr-2">
                  {agents.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className={cn(
                        'text-left text-sm rounded px-2 py-1.5 transition-colors',
                        editingId === a.id ? 'bg-primary/10 font-medium' : 'hover:bg-muted',
                      )}
                      onClick={() => void loadAgentIntoForm(a.id)}
                    >
                      {a.display_name}
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </div>
          ) : null}

          <ScrollArea className="flex-1 min-h-0 max-h-[40vh]">
            <div className="space-y-3 pr-3">
              <div className="space-y-2">
                <Label htmlFor="mgr-name">名称</Label>
                <Input
                  id="mgr-name"
                  placeholder="例如：行程规划"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  disabled={managerBusy}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mgr-prompt">人设与能力说明</Label>
                <Textarea
                  id="mgr-prompt"
                  placeholder="可选"
                  value={formPrompt}
                  onChange={(e) => setFormPrompt(e.target.value)}
                  disabled={managerBusy}
                  className="min-h-[88px]"
                />
              </div>
              <Separator />
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5 min-w-0">
                  <Label htmlFor="mgr-out">如需其他助手辅助时是否允许委派</Label>
                  <p className="text-xs text-muted-foreground leading-snug">
                    认为自己无法完成时，是否允许委派给其他助手。
                  </p>
                </div>
                <Switch
                  id="mgr-out"
                  checked={formOutgoing}
                  onCheckedChange={setFormOutgoing}
                  disabled={managerBusy}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5 min-w-0">
                  <Label htmlFor="mgr-in">是否可以被其他助手委派事务</Label>
                  <p className="text-xs text-muted-foreground leading-snug">关闭后其他助手无法委派给本助手。</p>
                </div>
                <Switch
                  id="mgr-in"
                  checked={formIncoming}
                  onCheckedChange={setFormIncoming}
                  disabled={managerBusy}
                />
              </div>
            </div>
          </ScrollArea>

          <DialogFooter className="flex-col sm:flex-row gap-2 shrink-0">
            {editingId ? (
              <Button
                type="button"
                variant="destructive"
                size="icon"
                className="rounded-lg sm:mr-auto"
                title="删除此助手"
                aria-label="删除此助手"
                disabled={managerBusy}
                onClick={() => void onManagerDelete()}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="sm:mr-auto rounded-lg"
                disabled={managerBusy}
                onClick={() => void onManagerDefaultTemplate()}
              >
                快速创建
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="rounded-lg"
              title="关闭"
              aria-label="关闭"
              onClick={() => setManagerOpen(false)}
              disabled={managerBusy}
            >
              <X className="size-4" aria-hidden />
            </Button>
            <Button
              type="button"
              size="icon"
              className="rounded-lg"
              title={editingId ? '保存更改' : '创建助手'}
              aria-label={editingId ? '保存更改' : '创建助手'}
              disabled={managerBusy || !formName.trim()}
              onClick={() => void onManagerSave()}
            >
              {managerBusy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Check className="size-4" aria-hidden />
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
