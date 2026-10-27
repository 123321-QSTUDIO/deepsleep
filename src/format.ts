export interface MsgSegment {
  type: string
  data: Record<string, unknown>
}

export function extractText(segments: MsgSegment[]): string {
  return segments
    .map((seg) => {
      const d = seg.data || {}
      switch (seg.type) {
        case 'text':
          return String(d.text ?? '')
        case 'at':
          return `[@${d.qq}]`
        case 'face':
          return `[表情]`
        case 'mface':
          return `[表情包${d.name ? ':' + String(d.name) : ''}]`
        case 'image': {
          const emojiId = String(d.emoji_id ?? '')
          const summary = String(d.summary ?? '')
          if (emojiId || summary) return `[表情包${summary ? ':' + summary : ''}]`
          return '[图片]'
        }
        case 'record':
          return d.text ? `[语音:${String(d.text)}]` : '[语音]'
        case 'video':
          return '[视频]'
        case 'file':
          return '[文件]'
        case 'json':
          return '[卡片消息]'
        case 'forward':
          return '[转发消息]'
        case 'reply':
          return ''
        default:
          return `[${seg.type}]`
      }
    })
    .join('')
    .trim()
}

export function extractReplyTo(segments: MsgSegment[]): number | null {
  const seg = segments.find((s) => s.type === 'reply')
  if (!seg) return null
  const id = Number(seg.data?.id)
  return Number.isFinite(id) ? id : null
}

export function extractAtTargets(segments: MsgSegment[]): string[] {
  return segments.filter((s) => s.type === 'at').map((s) => String(s.data?.qq ?? ''))
}

export function extractImages(segments: MsgSegment[]): { url: string; mime: string }[] {
  return segments
    .filter((s) => (s.type === 'image' || s.type === 'mface') && typeof s.data?.url === 'string')
    .map((s) => ({ url: String(s.data!.url), mime: 'image/jpeg' }))
}

function unescapeCq(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#44;/g, ',')
}

export function extractImagesFromRaw(raw: string): { url: string; mime: string }[] {
  const out: { url: string; mime: string }[] = []
  const re = /\[CQ:(?:image|mface),[^\]]*?url=([^,\]]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    out.push({ url: unescapeCq(m[1]), mime: 'image/jpeg' })
  }
  return out
}

// 模型偶尔会把消息包成 <text>...</text>（或转义成 &lt;text&gt;），还可能带尾部换行；
// 出站前统一清掉标签和多余空白，避免把标记当正文发到群里。
export function sanitizeOutgoingText(text: string): string {
  return text
    .replace(/&lt;\/?text\s*&gt;/gi, '')
    .replace(/<\/?text(?:\s[^>]*)?>/gi, '')
    .replace(/^[\s\u200b]+|[\s\u200b]+$/g, '')
    .replace(/\n{3,}/g, '\n\n')
}

// 给模型看的消息正文：raw 可能是纯 [CQ:at]（清洗后为空），此时回退到 segments 的可读文本；
// 纯表情/图片/空白消息也至少给一个可读占位，避免 prompt 出现 "用户:" 空行。
export function visibleMessageText(text: string, segments?: MsgSegment[]): string {
  let out = cleanCqForDisplay(String(text ?? '')).replace(/\s+/g, ' ').trim()
  if (!out && segments && segments.length > 0) {
    out = cleanCqForDisplay(extractText(segments)).replace(/\s+/g, ' ').trim()
  }
  return out || '[空白消息]'
}

export function textToSegments(text: string): Record<string, unknown>[] {
  text = sanitizeOutgoingText(text)
  const segs: Record<string, unknown>[] = []
  const re = /\[CQ:(at|face),(\w+)=([^\],]+)\]/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ type: 'text', data: { text: text.slice(last, m.index) } })
    if (m[1] === 'at') segs.push({ type: 'at', data: { qq: m[3] } })
    else segs.push({ type: 'face', data: { id: m[3] } })
    last = m.index + m[0].length
  }
  if (last < text.length) segs.push({ type: 'text', data: { text: text.slice(last) } })
  return segs.length > 0 ? segs : [{ type: 'text', data: { text } }]
}

export function dedupeImages(list: { url: string; mime: string }[]): { url: string; mime: string }[] {
  const seen = new Set<string>()
  return list.filter((i) => {
    if (!i.url.startsWith('http') || seen.has(i.url)) return false
    seen.add(i.url)
    return true
  })
}

export function cleanCqForDisplay(text: string): string {
  return text
    .replace(/,raw=\{[^\]]*\}/g, '')
    .replace(/\[CQ:(reply|at)[^\]]*\]/g, '')
    .replace(/\[CQ:(image|mface)[^\]]*\]/g, '[图片]')
    .replace(/\[CQ:record[^\]]*\]/g, '[语音]')
    .replace(/\[CQ:video[^\]]*\]/g, '[视频]')
    .replace(/\[CQ:file[^\]]*\]/g, '[文件]')
    .replace(/\[CQ:json[^\]]*\]/g, '[卡片消息]')
    .replace(/\[CQ:forward[^\]]*\]/g, '[转发消息]')
    .replace(/\[CQ:poke[^\]]*\]/g, '[戳一戳]')
}
