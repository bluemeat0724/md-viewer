/**
 * dsh-md-viewer — browser half. Runs inside the dsh web GUI: registers the
 * locale dictionaries and the three surfaces — the conversation header action,
 * the sidebar footer entry, and the full-screen viewer overlay (shell.overlay).
 * Failure policy: mount problems are logged, never thrown — the web shell
 * fails the whole boot when a plugin apply throws.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-ui-slots'

import { en, zh, type MdvKey } from './locales.ts'
import { HeaderAction } from './HeaderAction.tsx'
import { SidebarEntry } from './SidebarEntry.tsx'
import { ViewerOverlay } from './ViewerOverlay.tsx'

/** Locale namespace this plugin owns. */
const NS = 'dsh-md-viewer'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-md-viewer surface copy. */
    'dsh-md-viewer': MdvKey
  }

  interface SlotMap {
    /**
     * The conversation session header action row (beside the title):
     * one button per entry, ordered ascending. Owner passes nothing.
     */
    'conversation.session.header.actions': {
      kind: 'list'
      scope: 'session'
      owner: MdvHeaderActionOwnerProps
    }
    /**
     * The sidebar foot action row (beside the settings trigger):
     * owner passes the column display state.
     */
    'sidebar.footer.action': {
      kind: 'list'
      scope: 'root'
      owner: MdvSidebarEntryOwnerProps
    }
    /**
     * Frame-wide floating layer, above every column; entries are additive
     * and click-through until they opt back into pointer events. Owner
     * passes nothing.
     */
    'shell.overlay': {
      kind: 'list'
      scope: 'root'
      owner: MdvOverlayOwnerProps
    }
  }
}

/** Owner share of the header action seat (empty by contract). */
export interface MdvHeaderActionOwnerProps {
  children?: never
}

/** Owner share of the sidebar footer seat: the column display state. */
export interface MdvSidebarEntryOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/** Owner share of the overlay seat (empty by contract). */
export interface MdvOverlayOwnerProps {
  children?: never
}

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale']

/**
 * Mount the md-viewer surfaces.
 * @param ctx - client root context (locale + slots services).
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-md-viewer: dictionaries')

  const disposers: Array<() => void> = []
  try {
    disposers.push(
      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register({ name: 'conversation.session.header.actions', id: 'mdv-viewer', order: 15, locale: NS }, HeaderAction)),
    )
    disposers.push(
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'mdv-viewer-action', order: 4, locale: NS }, SidebarEntry)),
    )
    disposers.push(
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'mdv-viewer-overlay', order: 0, locale: NS }, ViewerOverlay)),
    )
  } catch (error) {
    // DOM failures degrade the viewer, never the GUI.
    console.warn('[dsh-md-viewer] mount failed:', error)
  }
  ctx.effect(
    () => () => {
      for (const dispose of disposers.splice(0)) dispose()
    },
    'dsh-md-viewer: ui mounts',
  )
}
