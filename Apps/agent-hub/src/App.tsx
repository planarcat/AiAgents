import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Bot, KeyRound, Loader2, Plus, Save, Send, Settings2, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { TooltipProvider } from '@/components/ui/tooltip'
import { AssistantConfigPanel, type SkillCatalogItem } from '@/components/AssistantConfigPanel'
import { ChatAssistantMarkdown } from '@/components/ChatAssistantMarkdown'
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
  skill_ids: string[]
}

/** IPC 可能为 snake_case 或 camelCase，统一后再用。 */
function normalizeSkillCatalog(raw: unknown): SkillCatalogItem[] {
  if (!Array.isArray(raw)) return []
  return raw.map((x) => {
    const o = x as Record<string, unknown>
    const toolName = String(o.tool_name ?? o.toolName ?? '')
    const displayName = String(
      o.display_name ?? o.displayName ?? toolName,
    ).trim()
    const rawDefault = o.is_default_load ?? o.isDefaultLoad
    const is_default_load =
      rawDefault === true || rawDefault === 1 || String(rawDefault) === '1'
    return {
      id: String(o.id ?? ''),
      tool_name: toolName,
      display_name: displayName || toolName,
      description: String(o.description ?? ''),
      kind: String(o.kind ?? 'builtin_static'),
      is_default_load,
    }
  })
}

/** agents_get 返回值字段名在部分环境下可能为 camelCase，skill_ids 读错会导致表单为空、保存时误覆盖库。 */
function normalizeAgentDetail(raw: unknown): AgentDetail {
  const o = raw as Record<string, unknown>
  const skillRaw = o.skill_ids ?? o.skillIds
  const skill_ids = Array.isArray(skillRaw) ? skillRaw.map((x) => String(x)) : []
  return {
    id: String(o.id ?? ''),
    display_name: String(o.display_name ?? o.displayName ?? ''),
    system_prompt: String(o.system_prompt ?? o.systemPrompt ?? ''),
    allows_outgoing_delegation: Boolean(o.allows_outgoing_delegation ?? o.allowsOutgoingDelegation),
    accepts_incoming_delegation: Boolean(o.accepts_incoming_delegation ?? o.acceptsIncomingDelegation),
    skill_ids,
  }
}

/** 保存前合并默认装载 id 并去重，与后端 merge_and_validate_skill_ids 一致。 */
function mergeSkillIdsForSave(catalog: SkillCatalogItem[], formIds: string[]): string[] {
  const defaults = catalog.filter((s) => s.is_default_load).map((s) => s.id)
  return [...new Set([...defaults, ...formIds])]
}

/** 与后端 `skills` 种子 id 对齐（用于把委派策略挂到对应能力卡片上）。 */
const SKILL_DELEGATE_ID = 'skill-builtin-delegate'

function sortSkillsForDisplay(items: SkillCatalogItem[]): SkillCatalogItem[] {
  return [...items].sort((a, b) =>
    a.display_name.localeCompare(b.display_name, 'zh-Hans-CN'),
  )
}

type SkillIconSize = 'sm' | 'md' | 'lg'

const SKILL_ICON_SIZE_STORAGE_KEY = 'agent-hub.skill-icon-size'

function readSkillIconSize(): SkillIconSize {
  try {
    const v = localStorage.getItem(SKILL_ICON_SIZE_STORAGE_KEY)
    if (v === 'sm' || v === 'md' || v === 'lg') return v
  } catch {
    /* ignore */
  }
  return 'md'
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

/** 能力装卸载变更保存后，引导用户减弱历史幻觉的说明文案 */
const SKILL_CHANGE_MAIN_COPY =
  '助手可用能力已经变更，大模型可能会无法感知本次变更并因为历史记忆而产生幻觉，你可以选择一个方案减弱大模型的幻觉。'

/** 「显式提醒」方案写入会话的 user 消息正文 */
const SKILL_CHANGE_REMINDER_TEXT =
  '你的可用能力列表已经更新，请检查当前的可用能力'

type SkillChangeChoiceId = 'ignore' | 'new_session' | 'remind' | 'compress'

/** 悬停按钮时显示，与用户给定方案描述一致 */
const SKILL_CHANGE_CHOICE_DESC: Record<SkillChangeChoiceId, string> = {
  ignore: '忽略警告，保持当前会话',
  new_session: '创建一个新的会话',
  remind: '将会发送一个对话提醒助手',
  compress: '将会压缩历史会话',
}

const PRESET_LABEL: Record<string, string> = {
  [PRESET_DEEPSEEK]: 'DeepSeek',
}

const REPLY_PHASE_LABEL: Record<string, string> = {
  thinking: '正在思考…',
  analyzing: '正在分析上下文…',
  tools: '正在调用工具…',
  generating: '正在生成回复…',
  summarizing: '正在压缩历史上下文…',
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
  /** 对话区只展示 user/assistant。`role=system` 写入 DB 供大模型读历史（如技能变更提示），不在此展示。 */
  const displayMessages = useMemo(
    () => messages.filter((m) => m.role !== 'system'),
    [messages],
  )
  const [convLoading, setConvLoading] = useState(false)
  const [input, setInput] = useState('')
  const [sendBusy, setSendBusy] = useState(false)
  /** 保存后技能变更：四选一方案弹窗 */
  const [skillChangeChoiceOpen, setSkillChangeChoiceOpen] = useState(false)
  const [pendingSkillChangeAgentId, setPendingSkillChangeAgentId] = useState<string | null>(null)
  const [skillChangeHoverChoice, setSkillChangeHoverChoice] =
    useState<SkillChangeChoiceId | null>(null)
  const skillChangeChoiceConfirmingRef = useRef(false)
  /** 用户确认后、在会话界面执行 `compress_conversations_after_skill_change` 期间 */
  const [compressBusy, setCompressBusy] = useState(false)
  /** 全量摘要完成（`skill_context_compression_done`） */
  const [skillCompressDialog, setSkillCompressDialog] = useState<{
    open: boolean
    count: number
  }>({ open: false, count: 0 })

  /** 主区为「配置助手」时 true，否则为对话 */
  const [configOpen, setConfigOpen] = useState(false)
  const [managerBusy, setManagerBusy] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formName, setFormName] = useState('')
  const [formPrompt, setFormPrompt] = useState('')
  const [formIncoming, setFormIncoming] = useState(true)
  const [skillCatalog, setSkillCatalog] = useState<SkillCatalogItem[]>([])
  const [skillCatalogLoading, setSkillCatalogLoading] = useState(false)
  const [formSkillIds, setFormSkillIds] = useState<string[]>([])

  /** 穿梭框：武装能力用于中间箭头移动 */
  const [armedSkillId, setArmedSkillId] = useState<string | null>(null)
  const [skillDetailOpen, setSkillDetailOpen] = useState(false)
  const [skillDetailId, setSkillDetailId] = useState<string | null>(null)
  const [addSkillHintOpen, setAddSkillHintOpen] = useState(false)
  const [skillIconSize, setSkillIconSize] = useState<SkillIconSize>(() => readSkillIconSize())

  const sortedSkills = useMemo(() => sortSkillsForDisplay(skillCatalog), [skillCatalog])

  const leftSkills = useMemo(
    () => sortedSkills.filter((s) => formSkillIds.includes(s.id)),
    [sortedSkills, formSkillIds],
  )
  const rightSkills = useMemo(
    () => sortedSkills.filter((s) => !formSkillIds.includes(s.id)),
    [sortedSkills, formSkillIds],
  )

  const skillDetail = useMemo(
    () => (skillDetailId ? skillCatalog.find((s) => s.id === skillDetailId) : undefined),
    [skillCatalog, skillDetailId],
  )

  const importRef = useRef<HTMLInputElement>(null)
  /** 对话主列表可滚动容器；贴底以保证滚动条默认在底部（最新消息一侧） */
  const chatScrollRef = useRef<HTMLDivElement>(null)
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
    if (skillChangeChoiceOpen) setSkillChangeHoverChoice(null)
  }, [skillChangeChoiceOpen])

  useEffect(() => {
    try {
      localStorage.setItem(SKILL_ICON_SIZE_STORAGE_KEY, skillIconSize)
    } catch {
      /* ignore */
    }
  }, [skillIconSize])

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

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void listen<{
      agent_id: string
      compressed_conversation_count: number
    }>('skill_context_compression_done', (event) => {
      if (cancelled) return
      setSkillCompressDialog({
        open: true,
        count: event.payload.compressed_conversation_count,
      })
    }).then((fn) => {
      if (!cancelled) unlisten = fn
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const resetManagerCreate = useCallback((catalogOverride?: SkillCatalogItem[]) => {
    const cat = catalogOverride ?? skillCatalog
    setEditingId(null)
    setFormName('')
    setFormPrompt('')
    setFormIncoming(true)
    setFormSkillIds(cat.filter((s) => s.is_default_load).map((s) => s.id))
    setArmedSkillId(null)
    setSkillDetailOpen(false)
    setSkillDetailId(null)
  }, [skillCatalog])

  const exitConfig = useCallback(() => {
    setConfigOpen(false)
    resetManagerCreate()
  }, [resetManagerCreate])

  const loadAgentIntoForm = useCallback(async (id: string) => {
    setManagerBusy(true)
    setSkillCatalogLoading(true)
    try {
      const [catRaw, dRaw] = await Promise.all([
        invoke<unknown>('skills_catalog'),
        invoke<unknown>('agents_get', { id }),
      ])
      const cat = normalizeSkillCatalog(catRaw)
      const d = normalizeAgentDetail(dRaw)
      setSkillCatalog(cat)
      setEditingId(d.id)
      setFormName(d.display_name)
      setFormPrompt(d.system_prompt)
      setFormIncoming(d.accepts_incoming_delegation)
      setFormSkillIds(mergeSkillIdsForSave(cat, d.skill_ids))
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setSkillCatalogLoading(false)
      setManagerBusy(false)
    }
  }, [])

  /** 配置助手：有选中则编辑该助手，否则为新建 */
  const openConfigEdit = useCallback(async () => {
    setConfigOpen(true)
    if (selectedId) {
      await loadAgentIntoForm(selectedId)
    } else {
      setSkillCatalogLoading(true)
      try {
        const raw = await invoke<unknown>('skills_catalog')
        const cat = normalizeSkillCatalog(raw)
        setSkillCatalog(cat)
        resetManagerCreate(cat)
      } catch (e) {
        window.alert(e instanceof Error ? e.message : String(e))
      } finally {
        setSkillCatalogLoading(false)
      }
    }
  }, [selectedId, loadAgentIntoForm, resetManagerCreate])

  /** 新增助手（新建模式） */
  const openConfigNew = useCallback(async () => {
    setConfigOpen(true)
    setSkillCatalogLoading(true)
    try {
      const raw = await invoke<unknown>('skills_catalog')
      const cat = normalizeSkillCatalog(raw)
      setSkillCatalog(cat)
      resetManagerCreate(cat)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setSkillCatalogLoading(false)
    }
  }, [resetManagerCreate])

  const toggleSkillId = useCallback((skillId: string, checked: boolean) => {
    const item = skillCatalog.find((s) => s.id === skillId)
    if (item?.is_default_load && !checked) return
    setFormSkillIds((prev) => {
      if (checked) return [...new Set([...prev, skillId])]
      return prev.filter((x) => x !== skillId)
    })
  }, [skillCatalog])

  const moveArmedToRight = useCallback(() => {
    if (!armedSkillId) return
    if (!formSkillIds.includes(armedSkillId)) return
    toggleSkillId(armedSkillId, false)
  }, [armedSkillId, formSkillIds, toggleSkillId])

  const moveArmedToLeft = useCallback(() => {
    if (!armedSkillId) return
    if (formSkillIds.includes(armedSkillId)) return
    toggleSkillId(armedSkillId, true)
  }, [armedSkillId, formSkillIds, toggleSkillId])

  const canMoveArmedRight = useMemo(() => {
    if (!armedSkillId) return false
    if (!formSkillIds.includes(armedSkillId)) return false
    const sk = skillCatalog.find((s) => s.id === armedSkillId)
    if (sk?.is_default_load) return false
    return true
  }, [armedSkillId, formSkillIds, skillCatalog])

  const canMoveArmedLeft = useMemo(() => {
    if (!armedSkillId) return false
    return !formSkillIds.includes(armedSkillId)
  }, [armedSkillId, formSkillIds])

  const loadThread = useCallback(async (agentId: string): Promise<ConversationState | null> => {
    setConvLoading(true)
    try {
      const c = await invoke<ConversationState>('conversations_ensure', { agentId })
      setConv(c)
      convIdRef.current = c.conversation_id
      const m = await invoke<ChatMessage[]>('messages_list', { conversationId: c.conversation_id })
      setMessages(m)
      return c
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
      setConv(null)
      setMessages([])
      return null
    } finally {
      setConvLoading(false)
    }
  }, [])

  /** 与「暂不考虑」一致：关闭弹窗并回到会话，不追加消息、不压缩 */
  const finishSkillChangeChoiceAndGoToSession = useCallback(
    (agentId: string | null) => {
      skillChangeChoiceConfirmingRef.current = true
      setSkillChangeChoiceOpen(false)
      setPendingSkillChangeAgentId(null)
      exitConfig()
      if (agentId) {
        setSelectedId(agentId)
        void loadThread(agentId)
      }
    },
    [exitConfig, loadThread],
  )

  const onSkillChangeChoiceOpenChange = useCallback(
    (open: boolean) => {
      if (open) return
      if (skillChangeChoiceConfirmingRef.current) {
        skillChangeChoiceConfirmingRef.current = false
        return
      }
      const aid = pendingSkillChangeAgentId
      finishSkillChangeChoiceAndGoToSession(aid)
    },
    [pendingSkillChangeAgentId, finishSkillChangeChoiceAndGoToSession],
  )

  const runSkillChangeCompress = useCallback(async () => {
    const aid = pendingSkillChangeAgentId
    skillChangeChoiceConfirmingRef.current = true
    setSkillChangeChoiceOpen(false)
    setPendingSkillChangeAgentId(null)
    exitConfig()
    if (!aid) return
    setSelectedId(aid)
    setCompressBusy(true)
    setReplyPhase('summarizing')
    try {
      await loadThread(aid)
      await invoke<number>('compress_conversations_after_skill_change', { agentId: aid })
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setCompressBusy(false)
      setReplyPhase('idle')
    }
  }, [pendingSkillChangeAgentId, exitConfig, loadThread])

  const runSkillChangeExplicitRemind = useCallback(async () => {
    const aid = pendingSkillChangeAgentId
    if (!aid) return
    skillChangeChoiceConfirmingRef.current = true
    setSkillChangeChoiceOpen(false)
    setPendingSkillChangeAgentId(null)
    exitConfig()
    setSelectedId(aid)
    const c = await loadThread(aid)
    if (!c) return
    const preset = c.llm_preset_id
    const ok = await refreshKeyOnly(preset)
    if (!ok) {
      window.alert(
        `尚未配置「${PRESET_LABEL[preset] ?? preset}」的 API 密钥。请点击右上角密钥图标，为该大模型保存密钥。`,
      )
      return
    }
    const t = SKILL_CHANGE_REMINDER_TEXT
    setReplyPhase('thinking')
    setSendBusy(true)
    try {
      await invoke<string>('chat_send', {
        conversationId: c.conversation_id,
        userText: t,
      })
      const m = await invoke<ChatMessage[]>('messages_list', {
        conversationId: c.conversation_id,
      })
      setMessages(m)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
      try {
        const m = await invoke<ChatMessage[]>('messages_list', {
          conversationId: c.conversation_id,
        })
        setMessages(m)
      } catch {
        /* ignore */
      }
    } finally {
      setSendBusy(false)
      setReplyPhase('idle')
    }
  }, [pendingSkillChangeAgentId, exitConfig, loadThread, refreshKeyOnly])

  useEffect(() => {
    if (!selectedId) {
      setConv(null)
      setMessages([])
      return
    }
    void loadThread(selectedId)
  }, [selectedId, loadThread])

  // `configOpen` 须参与依赖：切到「配置助手」时对话区被卸载（见下方 key），回到对话时
  // messages 往往不变，若不依赖 configOpen 则不会重贴底，滚动条会停在顶部。
  useLayoutEffect(() => {
    if (configOpen) return
    const el = chatScrollRef.current
    if (!el) return
    const snapBottom = () => {
      el.scrollTop = el.scrollHeight
    }
    snapBottom()
    const id = requestAnimationFrame(snapBottom)
    return () => cancelAnimationFrame(id)
  }, [configOpen, messages, convLoading, sendBusy, replyPhase, compressBusy])

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
      const skillIds = mergeSkillIdsForSave(skillCatalog, formSkillIds)
      let createdId: string | null = null
      if (editingId) {
        const r = await invoke<{ skills_changed: boolean }>('agents_update', {
          id: editingId,
          displayName: formName,
          systemPrompt: formPrompt,
          acceptsIncomingDelegation: formIncoming,
          skillIds,
        })
        if (r.skills_changed) {
          await refresh()
          setPendingSkillChangeAgentId(editingId)
          setSkillChangeChoiceOpen(true)
          return
        }
      } else {
        createdId = await invoke<string>('agents_create', {
          displayName: formName,
          systemPrompt: formPrompt,
          skillIds,
        })
      }
      await refresh()
      if (createdId) setSelectedId(createdId)
      exitConfig()
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
      exitConfig()
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
      exitConfig()
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

  const phaseLabel = compressBusy
    ? REPLY_PHASE_LABEL.summarizing
    : sendBusy && replyPhase !== 'idle'
      ? REPLY_PHASE_LABEL[replyPhase] ?? '正在处理…'
      : null

  return (
    <TooltipProvider delayDuration={80} skipDelayDuration={0}>
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
                        暂无助手。点击下方「新增助手」创建。
                      </p>
                    )
                  : (
                      agents.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => {
                            setSelectedId(a.id)
                            if (configOpen) {
                              void loadAgentIntoForm(a.id)
                            }
                          }}
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
          <div className="flex shrink-0 flex-col gap-2">
            <Button
              type="button"
              variant="outline"
              className="w-full justify-center gap-2 rounded-lg"
              title="配置当前选中的助手"
              aria-label="配置助手"
              onClick={() => {
                void openConfigEdit()
              }}
            >
              <Settings2 className="size-4 shrink-0" aria-hidden />
              配置助手
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full justify-center gap-2 rounded-lg"
              title="新建助手"
              aria-label="新增助手"
              onClick={() => {
                void openConfigNew()
              }}
            >
              <Plus className="size-4 shrink-0" aria-hidden />
              新增助手
            </Button>
          </div>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-5 md:p-6 lg:px-8 lg:pb-8">
          <div
            key={configOpen ? 'surface-config' : 'surface-chat'}
            className={cn(
              'flex min-h-0 flex-1 flex-col overflow-hidden',
              configOpen
                ? 'motion-reduce:animate-none animate-in fade-in-0 zoom-in-[0.985] slide-in-from-right-4 duration-350 ease-out'
                : 'motion-reduce:animate-none animate-in fade-in-0 zoom-in-[0.99] slide-in-from-left-3 duration-350 ease-out',
            )}
          >
          {configOpen ? (
            <AssistantConfigPanel
              key={editingId ?? 'new'}
              editingId={editingId}
              formName={formName}
              formPrompt={formPrompt}
              skillCatalog={skillCatalog}
              skillCatalogLoading={skillCatalogLoading}
              skillIconSize={skillIconSize}
              leftSkills={leftSkills}
              rightSkills={rightSkills}
              armedSkillId={armedSkillId}
              managerBusy={managerBusy}
              canMoveArmedRight={canMoveArmedRight}
              canMoveArmedLeft={canMoveArmedLeft}
              importRef={importRef}
              onExit={exitConfig}
              onSave={() => void onManagerSave()}
              onDelete={() => void onManagerDelete()}
              onDefaultTemplate={() => void onManagerDefaultTemplate()}
              onImportFile={(f) => void onImportFile(f)}
              resetManagerCreate={resetManagerCreate}
              setFormName={setFormName}
              setFormPrompt={setFormPrompt}
              setSkillIconSize={setSkillIconSize}
              setArmedSkillId={setArmedSkillId}
              setSkillDetailId={setSkillDetailId}
              setSkillDetailOpen={setSkillDetailOpen}
              setAddSkillHintOpen={setAddSkillHintOpen}
              toggleSkillId={toggleSkillId}
              formSkillIds={formSkillIds}
              moveArmedToRight={moveArmedToRight}
              moveArmedToLeft={moveArmedToLeft}
            />
          ) : !selected && !loading ? (
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
                <div
                  ref={chatScrollRef}
                  className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-xl border border-border/60 bg-muted/15 shadow-inner [-webkit-overflow-scrolling:touch]"
                >
                  <div className="space-y-3 p-4 md:p-5">
                    {convLoading ? (
                      <>
                        <Skeleton className="h-12 w-[72%] rounded-2xl" />
                        <Skeleton className="ml-auto h-12 w-[64%] rounded-2xl" />
                      </>
                    ) : displayMessages.length === 0 && !sendBusy && !compressBusy ? (
                      <p className="py-14 text-center text-sm text-muted-foreground">还没有消息。</p>
                    ) : (
                      displayMessages.map((m) => (
                        <div
                          key={m.id}
                          className={cn(
                            'max-w-[min(85%,36rem)] motion-reduce:animate-none animate-enter rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed break-words shadow-sm',
                            m.role === 'user'
                              ? 'ml-auto whitespace-pre-wrap bg-primary text-primary-foreground'
                              : 'mr-auto border border-border/60 bg-card text-card-foreground',
                          )}
                        >
                          {m.role === 'user' ? (
                            m.content
                          ) : (
                            <ChatAssistantMarkdown>{m.content}</ChatAssistantMarkdown>
                          )}
                        </div>
                      ))
                    )}
                    {(compressBusy || sendBusy) && phaseLabel ? (
                      <div className="motion-reduce:animate-none animate-enter-subtle mr-auto flex max-w-[min(85%,36rem)] items-center gap-2 rounded-2xl border border-dashed border-primary/30 bg-primary/5 px-3.5 py-2.5 text-sm text-muted-foreground">
                        <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
                        <span>{phaseLabel}</span>
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-end gap-3">
                  <Textarea
                    placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    disabled={sendBusy || convLoading || compressBusy}
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
                    disabled={sendBusy || convLoading || compressBusy || !input.trim()}
                    onClick={() => void onSend()}
                  >
                    {sendBusy || compressBusy ? (
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
        open={skillDetailOpen}
        onOpenChange={(o) => {
          setSkillDetailOpen(o)
          if (!o) setSkillDetailId(null)
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{skillDetail?.display_name ?? '能力详情'}</DialogTitle>
            <DialogDescription className="text-left text-sm leading-relaxed">
              {skillDetail?.description ?? '—'}
            </DialogDescription>
            {skillDetail ? (
              <p className="text-[11px] text-muted-foreground">
                内部工具名：<code className="rounded bg-muted px-1 py-px">{skillDetail.tool_name}</code>
              </p>
            ) : null}
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {skillDetail?.id === SKILL_DELEGATE_ID ? (
              <div className="space-y-3 rounded-lg border border-border/60 bg-muted/15 p-3">
                <p className="text-xs font-medium text-foreground">委派策略</p>
                <p className="text-xs text-muted-foreground leading-snug">
                  与工具 <code className="rounded bg-muted px-1 py-px text-[11px]">request_agent_help</code>{' '}
                  配套。向其他助手发起委派由本能力是否置于左侧「已装载」决定，与下方入站开关相互独立。
                </p>
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 space-y-0.5">
                    <Label htmlFor="skill-detail-mgr-in" className="text-sm font-normal">
                      允许接受来自其他助手的委派
                    </Label>
                    <p className="text-xs text-muted-foreground leading-snug">
                      关闭后其他助手无法委派事务给本助手。
                    </p>
                  </div>
                  <Switch
                    id="skill-detail-mgr-in"
                    checked={formIncoming}
                    onCheckedChange={setFormIncoming}
                    disabled={managerBusy}
                  />
                </div>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setSkillDetailOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={addSkillHintOpen} onOpenChange={setAddSkillHintOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新增能力</DialogTitle>
            <DialogDescription>
              自定义能力、连接器与能力库将在后续版本开放。当前请从目录内选择内置能力。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" onClick={() => setAddSkillHintOpen(false)}>
              知道了
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={skillChangeChoiceOpen} onOpenChange={onSkillChangeChoiceOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>能力变更</DialogTitle>
            <DialogDescription className="text-left text-foreground">
              {SKILL_CHANGE_MAIN_COPY}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3" onMouseLeave={() => setSkillChangeHoverChoice(null)}>
            <div className="min-h-[2.75rem]">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {skillChangeHoverChoice
                  ? SKILL_CHANGE_CHOICE_DESC[skillChangeHoverChoice]
                  : '\u00A0'}
              </p>
            </div>
            <div
              role="group"
              aria-label="选择减弱幻觉的方案"
              className="flex flex-wrap items-stretch justify-center gap-2"
            >
            <Button
              type="button"
              className="min-w-[5.5rem] flex-1 bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-600 sm:flex-none"
              onMouseEnter={() => setSkillChangeHoverChoice('ignore')}
              onClick={() => finishSkillChangeChoiceAndGoToSession(pendingSkillChangeAgentId)}
            >
              暂不考虑
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="min-w-[5.5rem] flex-1 sm:flex-none"
              disabled
              title="暂无"
              onMouseEnter={() => setSkillChangeHoverChoice('new_session')}
            >
              新开会话
            </Button>
            <Button
              type="button"
              className="min-w-[5.5rem] flex-1 bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:ring-emerald-600 sm:flex-none"
              onMouseEnter={() => setSkillChangeHoverChoice('remind')}
              onClick={() => void runSkillChangeExplicitRemind()}
            >
              显式提醒
            </Button>
            <Button
              type="button"
              className="min-w-[5.5rem] flex-1 bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:ring-emerald-600 sm:flex-none"
              onMouseEnter={() => setSkillChangeHoverChoice('compress')}
              onClick={() => void runSkillChangeCompress()}
            >
              压缩会话
            </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={skillCompressDialog.open}
        onOpenChange={(open) =>
          setSkillCompressDialog((d) => ({ ...d, open }))
        }
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>上下文已压缩</DialogTitle>
            <DialogDescription>
              因能力装载已变更，已对 {skillCompressDialog.count}{' '}
              个会话生成历史摘要并写入本地数据库；后续发消息时仅携带摘要之后的原文与摘要块。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              onClick={() => setSkillCompressDialog({ open: false, count: 0 })}
            >
              知道了
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </TooltipProvider>
  )
}
