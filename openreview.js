/**
 * openreview: public OpenReview API v2 submissions, reviews, and venue data.
 *
 * Optional tool: registers only with AH_ENABLE_OPTIONAL_TOOLS=1. Read-only;
 * schemas vary by venue, so missing fields stay missing (never inferred).
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { optionalToolsEnabled } from './optional-tools.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'

const API = 'https://api2.openreview.net'
const FORUM_URL = 'https://openreview.net/forum?id='

function value(content, key) {
  const raw = content?.[key]
  if (raw == null) return null
  return raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw
}

function errorOf(result, forumId) {
  if (result.error === 'aborted') return 'request cancelled'
  if (result.status === 403) {
    return `OpenReview returned HTTP 403 (browser verification required). Open ${forumId ? `${FORUM_URL}${forumId}` : 'https://openreview.net'} with the agent-browser skill, or retry later.`
  }
  const hint = result.status === 429 ? ' (rate limited; wait and retry)' : ''
  return `OpenReview API error ${result.status}${hint}${result.detail ? `: ${result.detail}` : ''}`
}

export function normalizeSubmission(note) {
  const content = note?.content || {}
  const forumId = note?.forum || note?.id || null
  return {
    forum_id: forumId,
    title: value(content, 'title'),
    authors: value(content, 'authors') || [],
    venue: value(content, 'venue'),
    venue_id: value(content, 'venueid'),
    pdf: value(content, 'pdf') || (forumId ? `${API.replace('api2.', '')}/pdf?id=${forumId}` : null),
    url: forumId ? `${FORUM_URL}${forumId}` : null,
  }
}

export function normalizeReview(note) {
  const content = note?.content || {}
  const invitations = note?.invitations || []
  const invitation = invitations.find((entry) => /review/i.test(entry)) || invitations[0] || null
  return {
    id: note?.id || null,
    invitation,
    rating: value(content, 'rating') ?? value(content, 'recommendation'),
    confidence: value(content, 'confidence'),
    summary: value(content, 'summary'),
    strengths: value(content, 'strengths'),
    weaknesses: value(content, 'weaknesses'),
    decision: value(content, 'decision'),
    url: note?.forum ? `${FORUM_URL}${note.forum}&noteId=${note.id}` : (note?.id ? `${FORUM_URL}${note.id}` : null),
  }
}

function looksLikeReview(note) {
  const invitations = (note?.invitations || []).join(' ')
  if (/review|rebuttal|meta_review/i.test(invitations)) return true
  return ['rating', 'recommendation', 'strengths', 'weaknesses'].some((key) => note?.content?.[key] != null)
}

export async function runOpenReview(args, exec, deps = {}) {
  const http = deps.fetchJson || fetchJson
  const action = args.action || 'search'
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 100)
  const limiter = getLimiter('openreview', { minIntervalMs: 1000 })

  if (action === 'search') {
    const query = String(args.query || '').trim()
    if (!query) return { error: 'query is required for search' }
    const params = new URLSearchParams({ term: query, limit: String(Math.min(limit, 50)), source: 'forum' })
    if (args.venue) params.set('group', String(args.venue).trim())
    const result = await limiter.run(() => http(`${API}/notes/search?${params}`, {
      signal: exec?.signal, headers: { 'User-Agent': searchUserAgent() },
    }))
    if (!result.ok) return { error: errorOf(result) }
    const notes = result.data?.notes || []
    return { action, count: result.data?.count ?? notes.length, results: notes.map(normalizeSubmission) }
  }

  if (action === 'reviews') {
    const forumId = String(args.forum_id || '').trim()
    if (!forumId) return { error: 'forum_id is required for reviews' }
    const result = await limiter.run(() => http(`${API}/notes?forum=${encodeURIComponent(forumId)}&limit=${limit}`, {
      signal: exec?.signal, headers: { 'User-Agent': searchUserAgent() },
    }))
    if (!result.ok) return { error: errorOf(result, forumId) }
    const notes = result.data?.notes || []
    if (!notes.length) return { action, forum_id: forumId, decision: null, reviews: [] }
    const submission = notes.find((note) => note.id === forumId) || notes.find((note) => !looksLikeReview(note)) || null
    const decision = notes.map((note) => value(note?.content, 'decision')).find(Boolean) || null
    return {
      action,
      forum_id: forumId,
      submission: submission ? normalizeSubmission(submission) : null,
      decision,
      reviews: notes.filter(looksLikeReview).map(normalizeReview),
    }
  }

  if (action === 'venue') {
    const venueId = String(args.venue_id || '').trim()
    if (!venueId) return { error: 'venue_id is required for venue' }
    const result = await limiter.run(() => http(`${API}/groups?id=${encodeURIComponent(venueId)}`, {
      signal: exec?.signal, headers: { 'User-Agent': searchUserAgent() },
    }))
    if (!result.ok) return { error: errorOf(result) }
    const group = result.data?.groups?.[0] || null
    if (!group) return { error: `venue not found: ${venueId}`, status: 404 }
    const content = group.content || {}
    return {
      action,
      venue_id: group.id || venueId,
      submission_name: value(content, 'submission_name'),
      submission_venue_id: value(content, 'submission_venue_id'),
      url: `https://openreview.net/group?id=${encodeURIComponent(group.id || venueId)}`,
    }
  }

  return { error: 'action must be search, reviews, or venue' }
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (value.action === 'venue') {
    return [{
      type: 'text',
      text: [
        `Venue: ${value.venue_id}`,
        value.submission_name ? `Submission name: ${value.submission_name}` : 'Submission name: absent',
        value.submission_venue_id ? `Submission venue id: ${value.submission_venue_id}` : 'Submission venue id: absent',
        value.url,
      ].join('\n'),
    }]
  }
  if (value.action === 'reviews') {
    const lines = [
      `${value.forum_id} — ${value.submission?.title || '(submission not returned)'}`,
      value.submission?.venue ? `Venue: ${value.submission.venue}` : null,
      `Decision: ${value.decision || 'not posted or not public'}`,
      `Reviews: ${value.reviews.length}`,
    ].filter(Boolean)
    for (const review of value.reviews) {
      lines.push('', `- ${review.invitation || 'review'}${review.rating != null ? ` · rating ${review.rating}` : ''}${review.confidence != null ? ` · confidence ${review.confidence}` : ''}`)
      if (review.summary) lines.push(`  Summary: ${review.summary}`)
      if (review.strengths) lines.push(`  Strengths: ${review.strengths}`)
      if (review.weaknesses) lines.push(`  Weaknesses: ${review.weaknesses}`)
    }
    if (value.submission?.url) lines.push('', value.submission.url)
    return [{ type: 'text', text: lines.join('\n') }]
  }
  const header = `${value.count ?? value.results.length} submission(s)`
  const body = value.results.map((item) => [
    `**${item.title || '(untitled)'}**`,
    [item.venue, item.authors?.length ? item.authors.join(', ') : null, item.forum_id].filter(Boolean).join(' · '),
    item.url,
  ].filter(Boolean).join('\n')).join('\n\n')
  return [{ type: 'text', text: `${header}\n\n${body}` }]
}

export const name = 'academic-harness-openreview'
export const inject = ['tools']

export function apply(ctx) {
  if (!optionalToolsEnabled()) return
  ctx.tools.register(defineTool({
    name: 'openreview',
    description: [
      'Read public OpenReview data: search submissions, fetch a forum\'s reviews and decision, and read venue metadata.',
      '`search` takes a `query` and optional `venue` group id; `reviews` takes `forum_id` and returns rating, confidence, summary, strengths, and weaknesses where the venue publishes them; `venue` takes `venue_id`. Fields absent for a venue are reported absent — never infer a rating or decision.',
      'Optional tool: present only when AH_ENABLE_OPTIONAL_TOOLS=1. Read-only and free. OpenReview may require an interactive browser challenge (HTTP 403); then open the forum URL with the agent-browser skill.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ['search', 'reviews', 'venue'], description: 'search (default), reviews, or venue.' },
      query: { type: 'string', description: 'Submission search query (search).' },
      venue: { type: 'string', description: 'Venue group id filter, e.g. ICLR.cc/2025/Conference (search).' },
      forum_id: { type: 'string', description: 'Forum/submission note id (reviews).' },
      venue_id: { type: 'string', description: 'Venue group id (venue).' },
      limit: { type: 'number', description: 'Results, 1-100. Default 10.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      return runOpenReview(args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `OpenReview: ${args.forum_id || args.venue_id || args.query || ''}`, kind: 'search' }
    },
  }))
}
