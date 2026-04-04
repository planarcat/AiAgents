import { invoke } from '@tauri-apps/api/core'
import { Bot, KeyRound, Plus, Upload } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

type AgentSummary = {
  id: string
  display_name: string
}

export default function App() {
  const [loading, setLoading] = useState(true)
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [apiKeyOk, setApiKeyOk] = useState(false)

  const [keyOpen, setKeyOpen] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)

  const [addOpen, setAddOpen] = useState(false)
  const [addName, setAddName] = useState('')
  const [addPrompt, setAddPrompt] = useState('')
  const [addBusy, setAddBusy] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [list, configured] = await Promise.all([
        invoke<AgentSummary[]>('agents_list'),
        invoke<boolean>('settings_api_key_configured'),
      ])
      setAgents(list)
      setApiKeyOk(configured)
      setSelectedId((cur) => {
        if (list.length === 0) return null
        if (cur && list.some((a) => a.id === cur)) return cur
        return list[0]!.id
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const selected = agents.find((a) => a.id === selectedId) ?? null

  async function onSaveKey() {
    setKeyBusy(true)
    try {
      await invoke('settings_save_api_key', { key: keyInput })
      setKeyInput('')
      setKeyOpen(false)
      setApiKeyOk(true)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setKeyBusy(false)
    }
  }

  async function onClearKey() {
    setKeyBusy(true)
    try {
      await invoke('settings_clear_api_key')
      setApiKeyOk(false)
      setKeyOpen(false)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setKeyBusy(false)
    }
  }

  async function onCreateAgent() {
    setAddBusy(true)
    try {
      await invoke('agents_create', {
        displayName: addName,
        systemPrompt: addPrompt,
      })
      setAddName('')
      setAddPrompt('')
      setAddOpen(false)
      await refresh()
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setAddBusy(false)
    }
  }

  async function onImportFile(f: FileList | null) {
    const file = f?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const n = await invoke<number>('agents_import_bulk', { json: text })
      window.alert(`已导入 ${n} 位助手`)
      await refresh()
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="h-svh flex flex-col bg-background text-foreground">
      <header className="h-14 shrink-0 border-b flex items-center justify-between gap-4 px-4">
        <div className="flex items-center gap-2 min-w-0">
          <Bot className="size-6 shrink-0 text-primary" aria-hidden />
          <span className="font-semibold tracking-tight truncate">协作助手</span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => setKeyOpen(true)}
        >
          <KeyRound className="size-4" aria-hidden />
          模型密钥
          {apiKeyOk ? (
            <span className="ml-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
              已配置
            </span>
          ) : (
            <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
              未配置
            </span>
          )}
        </Button>
      </header>

      <div className="flex flex-1 min-h-0">
        <aside className="w-64 shrink-0 border-r flex flex-col gap-3 p-3 bg-muted/20">
          <p className="text-xs font-medium text-muted-foreground px-1">我的助手</p>
          <ScrollArea className="flex-1 min-h-[120px] -mx-1">
            <div className="space-y-1 pr-2">
              {loading
                ? Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full rounded-md" />
                  ))
                : agents.length === 0
                  ? (
                      <div className="space-y-2 py-2">
                        {Array.from({ length: 3 }).map((_, i) => (
                          <Skeleton key={i} className="h-9 w-full rounded-md" />
                        ))}
                        <p className="text-xs text-muted-foreground px-1 pt-2 leading-relaxed">
                          还没有助手。使用下方按钮添加，或导入已有配置。
                        </p>
                      </div>
                    )
                  : (
                      agents.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => setSelectedId(a.id)}
                          className={cn(
                            'w-full rounded-md border px-3 py-2 text-left text-sm transition-colors',
                            selectedId === a.id
                              ? 'border-primary bg-primary/5 font-medium'
                              : 'border-transparent bg-background/80 hover:bg-muted/60',
                          )}
                        >
                          {a.display_name}
                        </button>
                      ))
                    )}
            </div>
          </ScrollArea>
          <Separator />
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              className="w-full justify-start gap-2"
              onClick={() => setAddOpen(true)}
            >
              <Plus className="size-4" aria-hidden />
              添加助手
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="w-full justify-start gap-2"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="size-4" aria-hidden />
              导入助手
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(ev) => void onImportFile(ev.target.files)}
            />
            <p className="text-[11px] text-muted-foreground leading-snug px-0.5">
              导入需为 JSON 数组，每项含 <span className="font-mono">display_name</span>
              ，可选 <span className="font-mono">system_prompt</span>。
            </p>
          </div>
        </aside>

        <main className="flex-1 flex flex-col min-w-0 min-h-0 p-4">
          {!selected && !loading ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-6 max-w-lg mx-auto w-full">
              <Card className="w-full border-dashed shadow-none">
                <CardHeader>
                  <CardTitle className="text-lg">开始之前</CardTitle>
                  <CardDescription>
                    添加或导入至少一位助手，并在右上角保存模型密钥后，即可在此对话。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex gap-2">
                    <Skeleton className="h-16 flex-1 rounded-lg" />
                    <Skeleton className="h-16 flex-1 rounded-lg" />
                  </div>
                  <Skeleton className="h-24 w-full rounded-lg" />
                </CardContent>
              </Card>
            </div>
          ) : (
            <Card className="flex-1 flex flex-col min-h-0 shadow-sm">
              <CardHeader className="shrink-0 border-b py-3">
                <CardTitle className="text-base">
                  {selected ? selected.display_name : '…'}
                </CardTitle>
                <CardDescription>
                  {apiKeyOk ? '选择左侧助手后，可在下方准备发送内容。' : '请先在右上角配置模型密钥。'}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col min-h-0 gap-3 pt-4">
                {!apiKeyOk ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100">
                    尚未保存模型密钥。请点击右上角「模型密钥」完成配置。
                  </div>
                ) : null}
                <ScrollArea className="flex-1 min-h-[200px] rounded-md border bg-muted/10">
                  <div className="p-4 space-y-3">
                    {loading ? (
                      <>
                        <Skeleton className="h-12 w-[72%] rounded-2xl" />
                        <Skeleton className="h-12 w-[64%] ml-auto rounded-2xl" />
                        <Skeleton className="h-12 w-[80%] rounded-2xl" />
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground text-center py-12">还没有消息。</p>
                    )}
                  </div>
                </ScrollArea>
                <div className="shrink-0 flex gap-2">
                  <Textarea
                    placeholder="输入消息…"
                    disabled
                    className="min-h-[72px] resize-none bg-muted/30"
                  />
                  <Button type="button" disabled className="self-end shrink-0">
                    发送
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </main>
      </div>

      <Dialog open={keyOpen} onOpenChange={setKeyOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>模型密钥</DialogTitle>
            <DialogDescription>
              由您使用的模型服务提供。密钥仅保存在本机系统保险箱中，不会在界面中明文显示或写入网页缓存。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="api-key">密钥</Label>
            <Input
              id="api-key"
              type="password"
              autoComplete="off"
              placeholder="在此粘贴密钥"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0 flex-col sm:flex-row">
            <Button type="button" variant="outline" onClick={() => void onClearKey()} disabled={keyBusy}>
              清除已保存
            </Button>
            <Button type="button" onClick={() => void onSaveKey()} disabled={keyBusy || !keyInput.trim()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>添加助手</DialogTitle>
            <DialogDescription>为助手起名并填写人设说明；留空人设时将使用默认说明。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="ag-name">名称</Label>
              <Input
                id="ag-name"
                placeholder="例如：行程规划"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ag-prompt">人设与能力说明</Label>
              <Textarea
                id="ag-prompt"
                placeholder="描述助手的专长与回答风格…"
                value={addPrompt}
                onChange={(e) => setAddPrompt(e.target.value)}
                className="min-h-[100px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
              取消
            </Button>
            <Button type="button" onClick={() => void onCreateAgent()} disabled={addBusy || !addName.trim()}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
