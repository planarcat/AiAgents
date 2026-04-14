import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

const components: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0 first:mt-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc pl-5 first:mt-0">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal pl-5 first:mt-0">{children}</ol>,
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  h1: ({ children }) => (
    <h1 className="mb-2 mt-3 border-b border-border/50 pb-1 text-lg font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-2 text-sm font-semibold first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1 mt-2 text-sm font-medium first:mt-0">{children}</h4>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-primary/45 pl-3 text-muted-foreground">{children}</blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      className="font-medium text-primary underline underline-offset-2 hover:opacity-90"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg border border-border/50 bg-muted/60 p-3 text-xs leading-relaxed">
      {children}
    </pre>
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = Boolean(className?.includes('language-'))
    if (isBlock) {
      return (
        <code className={cn('font-mono text-[0.8125rem]', className)} {...props}>
          {children}
        </code>
      )
    }
    return (
      <code className="rounded bg-muted/90 px-1 py-0.5 font-mono text-[0.85em]" {...props}>
        {children}
      </code>
    )
  },
  table: ({ children }) => (
    <div className="my-2 max-w-full overflow-x-auto">
      <table className="w-full min-w-[12rem] border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
  th: ({ children }) => (
    <th className="border border-border/70 px-2 py-1.5 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border/70 px-2 py-1.5 align-top">{children}</td>,
  tr: ({ children }) => <tr>{children}</tr>,
  hr: () => <hr className="my-3 border-border/60" />,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
}

type Props = {
  /** 助手消息正文 */
  children: string
  className?: string
}

/** 将助手回复按 Markdown（GFM）渲染，与对话区卡片样式协调 */
export function ChatAssistantMarkdown({ children, className }: Props) {
  return (
    <div className={cn('text-sm leading-relaxed break-words', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
