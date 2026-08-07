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
        case 'mface':
          return `[表情]`
        case 'image':
          return '[图片]'
        case 'record':
          return '[语音]'
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
    .replace(/\[CQ:(image|mface)[^\]]*\]/g, '[图片]')
    .replace(/\[CQ:record[^\]]*\]/g, '[语音]')
    .replace(/\[CQ:video[^\]]*\]/g, '[视频]')
    .replace(/\[CQ:file[^\]]*\]/g, '[文件]')
    .replace(/\[CQ:json[^\]]*\]/g, '[卡片消息]')
    .replace(/\[CQ:forward[^\]]*\]/g, '[转发消息]')
}
