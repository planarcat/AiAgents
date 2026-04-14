import {
  Check,
  ChevronLeft,
  ChevronRight,
  CloudSun,
  Layers,
  Loader2,
  Plus,
  PlusCircle,
  Share2,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const SKILL_DELEGATE_ID = 'skill-builtin-delegate'

/** 左右能力区可分配宽度比例（相对中间栏与 gap 之外的剩余宽度） */
const SHUTTLE_SPLIT_MIN = 0.25
const SHUTTLE_SPLIT_MAX = 0.75
/** 与 `gap-2`、侧栏 `w-11` 对齐，用于拖拽计算 */
const SHUTTLE_GAP_PX = 8
const SHUTTLE_MIDDLE_W_PX = 44
/** 中间栏（含穿梭箭头）按住约此时长后进入列宽拖拽（过短易与箭头短按冲突） */
const SHUTTLE_LONG_PRESS_MS = 220
/** 仅当明显滑走（如误触滚动）时取消长按，避免窄条上手抖取消 */
const SHUTTLE_LONG_PRESS_MOVE_CANCEL_PX = 48

export type SkillCatalogItem = {
  id: string
  tool_name: string
  display_name: string
  description: string
  kind: string
  /** 默认装载：不可从已装载区卸下 */
  is_default_load: boolean
}

export type SkillIconSize = 'sm' | 'md' | 'lg'

function skillIconForSkillId(id: string): LucideIcon {
  switch (id) {
    case SKILL_DELEGATE_ID:
      return Share2
    case 'skill-builtin-weather':
      return CloudSun
    case 'skill-builtin-list-loaded-skills':
      return Layers
    default:
      return Sparkles
  }
}

function skillIconSizeClasses(size: SkillIconSize): { wrap: string; icon: string } {
  switch (size) {
    case 'sm':
      return { wrap: 'size-9 rounded-lg', icon: 'size-5' }
    case 'lg':
      return { wrap: 'size-14 rounded-2xl', icon: 'size-8' }
    default:
      return { wrap: 'size-11 rounded-xl', icon: 'size-6' }
  }
}

function skillIconGapClass(size: SkillIconSize): string {
  switch (size) {
    case 'sm':
      return 'gap-1.5'
    case 'lg':
      return 'gap-2.5'
    default:
      return 'gap-2'
  }
}

function shuttleMinHeightClass(size: SkillIconSize): string {
  switch (size) {
    case 'sm':
      return 'min-h-[176px] md:min-h-[200px]'
    case 'lg':
      return 'min-h-[240px] md:min-h-[268px]'
    default:
      return 'min-h-[200px] md:min-h-[228px]'
  }
}

function SkillAbilityTooltipBody({ s }: { s: SkillCatalogItem }) {
  return (
    <div className="max-w-[min(85vw,20rem)] space-y-2 px-0.5 py-0.5">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm font-semibold leading-snug text-foreground">
          {s.display_name}
        </p>
        {s.is_default_load ? (
          <span
            className="shrink-0 rounded border border-primary/35 bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary"
            title="默认装载"
          >
            默认
          </span>
        ) : null}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{s.description}</p>
      <p className="border-t border-border/50 pt-2 text-[10px] leading-snug text-muted-foreground/90">
        点击编辑能力
      </p>
    </div>
  )
}

export type AssistantConfigPanelProps = {
  editingId: string | null
  formName: string
  formPrompt: string
  skillCatalog: SkillCatalogItem[]
  skillCatalogLoading: boolean
  skillIconSize: SkillIconSize
  leftSkills: SkillCatalogItem[]
  rightSkills: SkillCatalogItem[]
  armedSkillId: string | null
  managerBusy: boolean
  canMoveArmedRight: boolean
  canMoveArmedLeft: boolean
  importRef: RefObject<HTMLInputElement | null>
  onExit: () => void
  onSave: () => void
  onDelete: () => void
  onDefaultTemplate: () => void
  onImportFile: (f: FileList | null) => void
  resetManagerCreate: (catalogOverride?: SkillCatalogItem[]) => void
  setFormName: (v: string) => void
  setFormPrompt: (v: string) => void
  setSkillIconSize: (v: SkillIconSize) => void
  setArmedSkillId: (v: string | null) => void
  setSkillDetailId: (v: string | null) => void
  setSkillDetailOpen: (v: boolean) => void
  setAddSkillHintOpen: (v: boolean) => void
  toggleSkillId: (id: string, checked: boolean) => void
  formSkillIds: string[]
  moveArmedToRight: () => void
  moveArmedToLeft: () => void
}

export function AssistantConfigPanel(p: AssistantConfigPanelProps) {
  const [nameEditing, setNameEditing] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  /** 左侧区域占「左右可分配宽度」的比例，默认一半 */
  const [shuttleLeftRatio, setShuttleLeftRatio] = useState(0.5)
  const [shuttleSplitDragging, setShuttleSplitDragging] = useState(false)
  /** 按下中间栏未松手（含等待进入拖拽），用于即时高亮 */
  const [midStripPressed, setMidStripPressed] = useState(false)
  const shuttleRowRef = useRef<HTMLDivElement>(null)
  const shuttleLeftColumnRef = useRef<HTMLDivElement>(null)
  const shuttleRightColumnRef = useRef<HTMLDivElement>(null)
  const middleStripRef = useRef<HTMLDivElement>(null)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null)
  const shuttleSplitDraggingRef = useRef(false)
  const midPointerIdRef = useRef<number | null>(null)
  const splitDragPointerIdRef = useRef<number | null>(null)
  /** 结束列宽拖拽后的同一 tick 内抑制中间箭头误触 click */
  const suppressMidButtonClickRef = useRef(false)
  /** 能力图标 HTML5 拖拽进行中：避免外层 onMouseLeave 误清 armed；drop 时兜底 skill id（部分 WebView getData 为空） */
  const skillDragActiveRef = useRef(false)
  const dragSkillIdRef = useRef<string | null>(null)

  useEffect(() => {
    shuttleSplitDraggingRef.current = shuttleSplitDragging
  }, [shuttleSplitDragging])

  const resolveSkillDragId = useCallback((e: React.DragEvent) => {
    return (
      e.dataTransfer.getData('text/plain') ||
      e.dataTransfer.getData('application/x-skill-id') ||
      dragSkillIdRef.current
    )
  }, [])

  /** 中间栏或间隙松手：按当前是否在已装载列表切换 */
  const applySkillDropToggle = useCallback(
    (id: string) => {
      const sk = p.skillCatalog.find((x) => x.id === id)
      if (!sk) return
      if (p.formSkillIds.includes(id)) {
        if (sk.is_default_load) return
        p.toggleSkillId(id, false)
      } else {
        p.toggleSkillId(id, true)
      }
    },
    [p.skillCatalog, p.formSkillIds, p.toggleSkillId],
  )

  const cancelMidLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    longPressStartRef.current = null
  }, [])

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
    }
  }, [])

  const onMiddleStripPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (p.managerBusy) return
      if (e.button !== 0) return
      cancelMidLongPressTimer()
      setMidStripPressed(true)
      longPressStartRef.current = { x: e.clientX, y: e.clientY }
      midPointerIdRef.current = e.pointerId
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null
        longPressStartRef.current = null
        const pid = midPointerIdRef.current
        const el = middleStripRef.current
        if (pid == null || el == null) return
        try {
          el.setPointerCapture(pid)
        } catch {
          /* ignore */
        }
        splitDragPointerIdRef.current = pid
        shuttleSplitDraggingRef.current = true
        setShuttleSplitDragging(true)
      }, SHUTTLE_LONG_PRESS_MS)
    },
    [p.managerBusy, cancelMidLongPressTimer],
  )

  const onMiddleStripPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const start = longPressStartRef.current
      if (!longPressTimerRef.current || !start) return
      const dx = Math.abs(e.clientX - start.x)
      const dy = Math.abs(e.clientY - start.y)
      if (dx > SHUTTLE_LONG_PRESS_MOVE_CANCEL_PX || dy > SHUTTLE_LONG_PRESS_MOVE_CANCEL_PX) {
        cancelMidLongPressTimer()
        setMidStripPressed(false)
      }
    },
    [cancelMidLongPressTimer],
  )

  const onMiddleStripPointerUp = useCallback(() => {
    if (shuttleSplitDraggingRef.current) return
    cancelMidLongPressTimer()
    midPointerIdRef.current = null
    setMidStripPressed(false)
  }, [cancelMidLongPressTimer])

  useEffect(() => {
    setNameEditing(false)
  }, [p.editingId])

  /** 同步挂载 document 监听，避免长按生效后首帧尚未订阅导致无法拖拽 */
  useLayoutEffect(() => {
    if (!shuttleSplitDragging) return
    const onMove = (e: PointerEvent) => {
      if (splitDragPointerIdRef.current !== e.pointerId) return
      const row = shuttleRowRef.current
      if (!row) return
      const rect = row.getBoundingClientRect()
      const avail = rect.width - SHUTTLE_MIDDLE_W_PX - 2 * SHUTTLE_GAP_PX
      if (avail <= 1) return
      const minW = avail * SHUTTLE_SPLIT_MIN
      const maxW = avail * SHUTTLE_SPLIT_MAX
      const leftW = Math.min(Math.max(e.clientX - rect.left, minW), maxW)
      setShuttleLeftRatio(leftW / avail)
    }
    const onUp = (e: PointerEvent) => {
      if (splitDragPointerIdRef.current !== e.pointerId) return
      const el = middleStripRef.current
      const pid = splitDragPointerIdRef.current
      if (el != null && pid != null) {
        try {
          el.releasePointerCapture(pid)
        } catch {
          /* ignore */
        }
      }
      splitDragPointerIdRef.current = null
      midPointerIdRef.current = null
      shuttleSplitDraggingRef.current = false
      setShuttleSplitDragging(false)
      setMidStripPressed(false)
      suppressMidButtonClickRef.current = true
      window.setTimeout(() => {
        suppressMidButtonClickRef.current = false
      }, 0)
    }
    document.addEventListener('pointermove', onMove, { capture: true, passive: true })
    document.addEventListener('pointerup', onUp, { capture: true })
    document.addEventListener('pointercancel', onUp, { capture: true })
    return () => {
      document.removeEventListener('pointermove', onMove, { capture: true })
      document.removeEventListener('pointerup', onUp, { capture: true })
      document.removeEventListener('pointercancel', onUp, { capture: true })
    }
  }, [shuttleSplitDragging])

  useEffect(() => {
    if (!nameEditing) return
    const id = window.requestAnimationFrame(() => {
      const el = nameInputRef.current
      if (!el) return
      el.focus()
      el.select()
    })
    return () => window.cancelAnimationFrame(id)
  }, [nameEditing])

  const displayName = p.formName.trim() || '未命名助手'

  /** 与 shadcn Input 默认样式对齐：同高、同宽、同内边距与边框，避免编辑态切换跳动 */
  const nameFieldShell =
    'h-9 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm'

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/80 bg-card shadow-md">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-border/60 bg-muted/25 px-4 py-3 md:px-5">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-base font-semibold tracking-tight">配置助手</h2>
          <div className="min-w-0 max-w-md">
            {nameEditing ? (
              <Input
                ref={nameInputRef}
                id="mgr-name"
                className={cn(nameFieldShell, 'ring-offset-background focus-visible:ring-2 focus-visible:ring-ring')}
                value={p.formName}
                onChange={(e) => p.setFormName(e.target.value)}
                onBlur={() => setNameEditing(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    ;(e.target as HTMLInputElement).blur()
                  }
                }}
                disabled={p.managerBusy}
                placeholder="例如：行程规划"
                aria-label="助手名称"
              />
            ) : (
              <button
                type="button"
                disabled={p.managerBusy}
                onClick={() => setNameEditing(true)}
                className={cn(
                  nameFieldShell,
                  'flex min-h-9 items-center truncate text-left text-foreground transition-colors',
                  'hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  'disabled:pointer-events-none disabled:opacity-50',
                )}
              >
                {displayName}
              </button>
            )}
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="shrink-0 rounded-lg"
          title="退出配置"
          aria-label="退出配置"
          onClick={() => p.onExit()}
          disabled={p.managerBusy}
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      {!p.editingId ? (
        <div className="flex shrink-0 flex-wrap gap-2 border-b border-border/60 px-4 py-2 md:px-5">
          <Button
            type="button"
            size="icon"
            variant="default"
            className="rounded-lg"
            title="清空表单"
            aria-label="清空表单"
            onClick={() => p.resetManagerCreate(p.skillCatalog)}
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
            onClick={() => p.importRef.current?.click()}
          >
            <Upload className="size-4" aria-hidden />
          </Button>
          <input
            ref={p.importRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(ev) => void p.onImportFile(ev.target.files)}
          />
        </div>
      ) : null}

      <div
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 md:px-5 [-webkit-overflow-scrolling:touch]"
        role="region"
        aria-label="助手表单与能力"
      >
        <div className="space-y-3 pr-1">
          <div className="flex flex-wrap items-start justify-between gap-3 px-0.5">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold tracking-tight">能力配置</h3>
            </div>
            <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
              {!p.skillCatalogLoading && p.skillCatalog.length > 0 ? (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <span className="text-[11px] text-muted-foreground">图标大小</span>
                  <div
                    className="inline-flex rounded-lg border border-border/60 bg-muted/40 p-0.5"
                    role="group"
                    aria-label="能力图标大小"
                  >
                    <Button
                      type="button"
                      variant={p.skillIconSize === 'sm' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="h-7 min-w-[2.25rem] rounded-md px-2 text-xs"
                      disabled={p.managerBusy}
                      onClick={() => p.setSkillIconSize('sm')}
                    >
                      小
                    </Button>
                    <Button
                      type="button"
                      variant={p.skillIconSize === 'md' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="h-7 min-w-[2.25rem] rounded-md px-2 text-xs"
                      disabled={p.managerBusy}
                      onClick={() => p.setSkillIconSize('md')}
                    >
                      中
                    </Button>
                    <Button
                      type="button"
                      variant={p.skillIconSize === 'lg' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="h-7 min-w-[2.25rem] rounded-md px-2 text-xs"
                      disabled={p.managerBusy}
                      onClick={() => p.setSkillIconSize('lg')}
                    >
                      大
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <Card className="border-border/70 shadow-sm">
            <CardHeader className="space-y-1 p-4 pb-2">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-sm font-semibold">对话策略</CardTitle>
                <span className="rounded-full border border-border/80 bg-muted/30 px-2 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  System
                </span>
              </div>
              <CardDescription className="text-xs leading-relaxed">
                定义语气、知识边界、何时调用下方工具等；相当于模型系统提示（System Prompt）。
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <Label htmlFor="mgr-prompt" className="sr-only">
                对话策略
              </Label>
              <Textarea
                id="mgr-prompt"
                placeholder="可选：描述助手如何回答、如何配合工具使用…"
                value={p.formPrompt}
                onChange={(e) => p.setFormPrompt(e.target.value)}
                disabled={p.managerBusy}
                className="min-h-[80px] resize-y"
              />
            </CardContent>
          </Card>

          {p.skillCatalogLoading ? (
            <div className="flex items-center gap-2 rounded-lg border border-dashed border-border/80 bg-muted/10 px-4 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
              <span>正在加载能力目录…</span>
            </div>
          ) : p.skillCatalog.length === 0 ? (
            <div className="flex items-start justify-between gap-2 rounded-lg border border-dashed border-border/80 bg-muted/10 px-4 py-4">
              <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                未获取到能力列表。请确认已用 Tauri 运行应用且数据库迁移已执行。
              </p>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="shrink-0 rounded-lg"
                disabled={p.managerBusy}
                aria-label="新增能力"
                title="新增能力"
                onClick={() => p.setAddSkillHintOpen(true)}
              >
                <PlusCircle className="size-4" aria-hidden />
              </Button>
            </div>
          ) : (
            <div
              className="rounded-2xl border border-border/70 bg-muted/5 p-2"
              onMouseLeave={() => {
                if (skillDragActiveRef.current) return
                p.setArmedSkillId(null)
              }}
            >
              <div
                ref={shuttleRowRef}
                className={cn('flex min-h-0 gap-2', shuttleMinHeightClass(p.skillIconSize))}
                style={shuttleSplitDragging ? { touchAction: 'none' } : undefined}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  const row = shuttleRowRef.current
                  if (!row) return
                  const t = e.target as Node
                  if (t !== row && row.contains(t)) {
                    if (shuttleLeftColumnRef.current?.contains(t)) return
                    if (shuttleRightColumnRef.current?.contains(t)) return
                    if (middleStripRef.current?.contains(t)) return
                  }
                  const id = resolveSkillDragId(e)
                  if (!id) return
                  const leftR = shuttleLeftColumnRef.current?.getBoundingClientRect()
                  const rightR = shuttleRightColumnRef.current?.getBoundingClientRect()
                  const midR = middleStripRef.current?.getBoundingClientRect()
                  const x = e.clientX
                  if (leftR && x >= leftR.left && x <= leftR.right) {
                    if (!p.formSkillIds.includes(id)) p.toggleSkillId(id, true)
                    return
                  }
                  if (rightR && x >= rightR.left && x <= rightR.right) {
                    const sk = p.skillCatalog.find((s) => s.id === id)
                    if (!sk) return
                    if (p.formSkillIds.includes(id)) p.toggleSkillId(id, false)
                    return
                  }
                  if (midR && x >= midR.left && x <= midR.right) {
                    applySkillDropToggle(id)
                    return
                  }
                  const rr = row.getBoundingClientRect()
                  const center = rr.left + rr.width / 2
                  if (x < center) {
                    if (!p.formSkillIds.includes(id)) p.toggleSkillId(id, true)
                  } else {
                    const sk = p.skillCatalog.find((s) => s.id === id)
                    if (!sk) return
                    if (p.formSkillIds.includes(id) && !sk.is_default_load)
                      p.toggleSkillId(id, false)
                  }
                }}
              >
                <div
                  ref={shuttleLeftColumnRef}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    const id = resolveSkillDragId(e)
                    if (!id) return
                    if (!p.formSkillIds.includes(id)) p.toggleSkillId(id, true)
                  }}
                  className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-background/90"
                  style={{ flex: `${shuttleLeftRatio} 1 0%` }}
                >
                  <p className="shrink-0 border-b border-border/50 bg-muted/20 px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    已装载
                  </p>
                  <div
                    className={cn(
                      'flex flex-1 flex-wrap content-start justify-start overflow-y-auto p-3',
                      skillIconGapClass(p.skillIconSize),
                    )}
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                    }}
                  >
                    {p.leftSkills.map((s) => {
                      const Icon = skillIconForSkillId(s.id)
                      const sc = skillIconSizeClasses(p.skillIconSize)
                      return (
                        <Tooltip key={s.id} delayDuration={0} disableHoverableContent>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              draggable={!s.is_default_load}
                              onMouseEnter={() => p.setArmedSkillId(s.id)}
                              onDragEnter={(e) => {
                                e.preventDefault()
                                p.setArmedSkillId(s.id)
                              }}
                              onDragOver={(e) => {
                                e.preventDefault()
                                e.dataTransfer.dropEffect = 'move'
                              }}
                              onDragStart={(e) => {
                                skillDragActiveRef.current = true
                                dragSkillIdRef.current = s.id
                                e.dataTransfer.setData('text/plain', s.id)
                                e.dataTransfer.setData('application/x-skill-id', s.id)
                                e.dataTransfer.effectAllowed = 'move'
                              }}
                              onDragEnd={() => {
                                skillDragActiveRef.current = false
                                dragSkillIdRef.current = null
                                p.setArmedSkillId(null)
                              }}
                              onClick={() => {
                                p.setSkillDetailId(s.id)
                                p.setSkillDetailOpen(true)
                              }}
                              disabled={p.managerBusy}
                              className={cn(
                                'flex shrink-0 items-center justify-center border bg-card text-primary shadow-sm transition-[box-shadow,transform] hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]',
                                sc.wrap,
                                p.armedSkillId === s.id &&
                                  'ring-2 ring-primary ring-offset-2 ring-offset-background',
                              )}
                            >
                              <Icon className={cn(sc.icon, 'shrink-0')} aria-hidden />
                              <span className="sr-only">{s.display_name}</span>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent
                            key={s.id}
                            side="top"
                            align="center"
                            className="border-border/70 bg-card/95 p-3 shadow-xl backdrop-blur-md"
                          >
                            <SkillAbilityTooltipBody s={s} />
                          </TooltipContent>
                        </Tooltip>
                      )
                    })}
                  </div>
                </div>

                <div
                  ref={middleStripRef}
                  className={cn(
                    'flex w-11 shrink-0 touch-none flex-col items-center justify-center gap-2 border-x border-dashed border-border/50 px-0.5',
                    'cursor-ew-resize select-none transition-[background-color,box-shadow] duration-100',
                    midStripPressed && !shuttleSplitDragging && 'bg-muted/15 ring-1 ring-inset ring-primary/15',
                    shuttleSplitDragging && 'bg-muted/30 ring-1 ring-inset ring-primary/40',
                  )}
                  title="按住此区域（含箭头）片刻后拖动调整左右宽度"
                  onPointerDown={onMiddleStripPointerDown}
                  onPointerMove={onMiddleStripPointerMove}
                  onPointerUp={onMiddleStripPointerUp}
                  onPointerCancel={onMiddleStripPointerUp}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    const id = resolveSkillDragId(e)
                    if (!id) return
                    applySkillDropToggle(id)
                  }}
                >
                  <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    className="size-9 rounded-lg"
                    title="卸载到右侧（需先悬停要操作的能力图标）"
                    disabled={p.managerBusy || !p.canMoveArmedRight}
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerUp={(e) => e.stopPropagation()}
                    onPointerCancel={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (suppressMidButtonClickRef.current) {
                        e.preventDefault()
                        return
                      }
                      p.moveArmedToRight()
                    }}
                  >
                    <ChevronRight className="size-4" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    className="size-9 rounded-lg"
                    title="装载到左侧（需先悬停要操作的能力图标）"
                    disabled={p.managerBusy || !p.canMoveArmedLeft}
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerUp={(e) => e.stopPropagation()}
                    onPointerCancel={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (suppressMidButtonClickRef.current) {
                        e.preventDefault()
                        return
                      }
                      p.moveArmedToLeft()
                    }}
                  >
                    <ChevronLeft className="size-4" aria-hidden />
                  </Button>
                </div>

                <div
                  ref={shuttleRightColumnRef}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    const id = resolveSkillDragId(e)
                    if (!id) return
                    const sk = p.skillCatalog.find((x) => x.id === id)
                    if (!sk) return
                    if (p.formSkillIds.includes(id) && !sk.is_default_load)
                      p.toggleSkillId(id, false)
                  }}
                  className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-background/90"
                  style={{ flex: `${1 - shuttleLeftRatio} 1 0%` }}
                >
                  <div className="relative flex shrink-0 items-center justify-center border-b border-border/50 bg-muted/20 px-2 py-1.5">
                    <span className="pointer-events-none text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      未装载
                    </span>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="absolute right-1 top-1/2 size-7 -translate-y-1/2 rounded-lg text-muted-foreground hover:text-foreground"
                      disabled={p.managerBusy}
                      aria-label="新增能力"
                      title="新增能力"
                      onClick={() => p.setAddSkillHintOpen(true)}
                    >
                      <PlusCircle className="size-4" aria-hidden />
                    </Button>
                  </div>
                  <div
                    className={cn(
                      'flex flex-1 min-h-0 overflow-y-auto p-3',
                      p.rightSkills.length === 0
                        ? 'items-center justify-center'
                        : cn('flex-wrap content-start justify-start', skillIconGapClass(p.skillIconSize)),
                    )}
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                    }}
                  >
                    {p.rightSkills.length === 0 ? (
                      <p className="max-w-[min(100%,15rem)] text-center text-xs leading-relaxed text-muted-foreground">
                        <span className="block">没有更多能力可选</span>
                        <span className="block">点击旁侧新增图标</span>
                      </p>
                    ) : (
                      p.rightSkills.map((s) => {
                        const Icon = skillIconForSkillId(s.id)
                        const sc = skillIconSizeClasses(p.skillIconSize)
                        return (
                          <Tooltip key={s.id} delayDuration={0} disableHoverableContent>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                draggable
                                onMouseEnter={() => p.setArmedSkillId(s.id)}
                                onDragEnter={(e) => {
                                  e.preventDefault()
                                  p.setArmedSkillId(s.id)
                                }}
                                onDragOver={(e) => {
                                  e.preventDefault()
                                  e.dataTransfer.dropEffect = 'move'
                                }}
                                onDragStart={(e) => {
                                  skillDragActiveRef.current = true
                                  dragSkillIdRef.current = s.id
                                  e.dataTransfer.setData('text/plain', s.id)
                                  e.dataTransfer.setData('application/x-skill-id', s.id)
                                  e.dataTransfer.effectAllowed = 'move'
                                }}
                                onDragEnd={() => {
                                  skillDragActiveRef.current = false
                                  dragSkillIdRef.current = null
                                  p.setArmedSkillId(null)
                                }}
                                onClick={() => {
                                  p.setSkillDetailId(s.id)
                                  p.setSkillDetailOpen(true)
                                }}
                                disabled={p.managerBusy}
                                className={cn(
                                  'flex shrink-0 items-center justify-center border border-dashed bg-muted/20 text-muted-foreground shadow-sm transition-[box-shadow,transform] hover:border-border hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]',
                                  sc.wrap,
                                  p.armedSkillId === s.id &&
                                    'ring-2 ring-primary ring-offset-2 ring-offset-background',
                                )}
                              >
                                <Icon className={cn(sc.icon, 'shrink-0')} aria-hidden />
                                <span className="sr-only">{s.display_name}</span>
                              </button>
                            </TooltipTrigger>
                            <TooltipContent
                              key={s.id}
                              side="top"
                              align="center"
                              className="border-border/70 bg-card/95 p-3 shadow-xl backdrop-blur-md"
                            >
                              <SkillAbilityTooltipBody s={s} />
                            </TooltipContent>
                          </Tooltip>
                        )
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border/60 bg-muted/20 px-4 py-3 md:px-5">
        {p.editingId ? (
          <Button
            type="button"
            variant="destructive"
            size="icon"
            className="rounded-lg sm:mr-auto"
            title="删除此助手"
            aria-label="删除此助手"
            disabled={p.managerBusy}
            onClick={() => void p.onDelete()}
          >
            <Trash2 className="size-4" aria-hidden />
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="sm:mr-auto rounded-lg"
            disabled={p.managerBusy}
            onClick={() => void p.onDefaultTemplate()}
          >
            快速创建
          </Button>
        )}
        <Button
          type="button"
          size="icon"
          className="rounded-lg"
          title={p.editingId ? '保存更改' : '创建助手'}
          aria-label={p.editingId ? '保存更改' : '创建助手'}
          disabled={p.managerBusy || !p.formName.trim()}
          onClick={() => void p.onSave()}
        >
          {p.managerBusy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Check className="size-4" aria-hidden />
          )}
        </Button>
      </div>
    </div>
  )
}

/** 外层已包 TooltipProvider 时，穿梭内 Tooltip 仍可用 */
export function AssistantConfigPanelWithTooltipProvider(p: AssistantConfigPanelProps) {
  return (
    <TooltipProvider delayDuration={80} skipDelayDuration={0}>
      <AssistantConfigPanel {...p} />
    </TooltipProvider>
  )
}
