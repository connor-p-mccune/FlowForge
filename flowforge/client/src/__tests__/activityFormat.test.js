import { describe, it, expect } from 'vitest'
import {
  formatEvent,
  actorLabel,
  entityHref,
  initials,
  actorColor,
} from '../components/activity/format'

const base = {
  actor_display_name: 'Olivia',
  entity_type: 'workflow',
  entity_id: 'wf1',
  entity_name: 'Webhook Alerter',
  metadata: null,
}

describe('formatEvent', () => {
  it('maps each event type to a human-readable phrase', () => {
    expect(formatEvent({ ...base, event_type: 'workflow.created' }))
      .toBe('created workflow Webhook Alerter')
    expect(formatEvent({ ...base, event_type: 'workflow.updated' }))
      .toBe('edited workflow Webhook Alerter')
    expect(formatEvent({ ...base, event_type: 'workflow.deployed', metadata: { version: 2 } }))
      .toBe('deployed Webhook Alerter (v2)')
    expect(formatEvent({ ...base, event_type: 'workflow.deployed' }))
      .toBe('deployed Webhook Alerter')
    expect(formatEvent({ ...base, event_type: 'workflow.deleted' }))
      .toBe('deleted workflow Webhook Alerter')
    expect(formatEvent({ ...base, event_type: 'workflow.restored', metadata: { version: 5 } }))
      .toBe('restored Webhook Alerter to v5')
    expect(formatEvent({ ...base, event_type: 'execution.completed', entity_name: 'Nightly Sync' }))
      .toBe('ran Nightly Sync')
    expect(formatEvent({ ...base, event_type: 'execution.failed', entity_name: 'Nightly Sync' }))
      .toBe('ran Nightly Sync — failed')
    expect(formatEvent({ ...base, event_type: 'member.invited', entity_name: 'Marty' }))
      .toBe('added Marty to the workspace')
    expect(formatEvent({ ...base, event_type: 'member.removed', entity_name: 'Marty' }))
      .toBe('removed Marty from the workspace')
    expect(formatEvent({ ...base, event_type: 'comment.added', entity_name: 'My Flow' }))
      .toBe('commented on My Flow')
    expect(formatEvent({ ...base, event_type: 'comment.resolved', entity_name: 'My Flow' }))
      .toBe('resolved a comment on My Flow')
  })

  it('degrades gracefully for an unknown event type', () => {
    expect(formatEvent({ ...base, event_type: 'widget.frobbed', entity_name: 'Thing' }))
      .toBe('widget frobbed Thing')
  })

  it('falls back to "a workflow" when the entity name is missing', () => {
    expect(formatEvent({ event_type: 'workflow.deployed', entity_name: null, metadata: null }))
      .toBe('deployed a workflow')
  })
})

describe('actorLabel', () => {
  it('uses the display name when present', () => {
    expect(actorLabel({ actor_display_name: 'Olivia' })).toBe('Olivia')
  })
  it('labels system runs by trigger type when there is no actor', () => {
    expect(actorLabel({ actor_display_name: null, metadata: { triggerType: 'webhook' } }))
      .toBe('A webhook')
    expect(actorLabel({ actor_display_name: null, metadata: { triggerType: 'schedule' } }))
      .toBe('A schedule')
    expect(actorLabel({ actor_display_name: null, metadata: {} })).toBe('Someone')
  })
})

describe('entityHref', () => {
  it('links workflow events to the workflow canvas', () => {
    expect(entityHref({ entity_type: 'workflow', entity_id: 'wf1' })).toBe('/workflow/wf1')
  })
  it('links execution/comment events to their workflow via metadata', () => {
    expect(entityHref({ entity_type: 'execution', metadata: { workflowId: 'wf9' } }))
      .toBe('/workflow/wf9')
    expect(entityHref({ entity_type: 'comment', metadata: { workflowId: 'wf9' } }))
      .toBe('/workflow/wf9')
  })
  it('has no link for member events', () => {
    expect(entityHref({ entity_type: 'member', entity_id: 'u1' })).toBeNull()
  })
})

describe('initials & actorColor', () => {
  it('builds up-to-two-letter initials', () => {
    expect(initials('Olivia Owner')).toBe('OO')
    expect(initials('Marty')).toBe('M')
    expect(initials('')).toBe('?')
    expect(initials(null)).toBe('?')
  })
  it('is deterministic for a given key', () => {
    expect(actorColor('u1')).toBe(actorColor('u1'))
    expect(actorColor('u1')).toMatch(/^#[0-9a-f]{6}$/)
  })
})
