'use client'

import { useState } from 'react'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useChatroomStore } from '@/stores/use-chatroom-store'
import { ChatroomList } from '@/components/chatrooms/chatroom-list'
import { ChatroomView } from '@/components/chatrooms/chatroom-view'
import { MainContent } from '@/components/layout/main-content'

export default function ChatroomsPage() {
  const [viewMode, setViewMode] = useState<'chatrooms' | 'sessions'>('chatrooms')
  // Mobile (<768px): single column — room list first, chat after tapping a
  // room, with a back button. Desktop keeps the two-column layout.
  const isDesktop = useMediaQuery('(min-width: 768px)')
  const [mobileChatOpen, setMobileChatOpen] = useState(false)
  const showList = isDesktop || !mobileChatOpen
  const showChat = isDesktop || mobileChatOpen

  return (
    <MainContent>
      <div className="flex-1 flex h-full min-w-0 overflow-hidden">
        {showList && (
          <div className="w-[280px] shrink-0 border-r border-white/[0.06] flex flex-col max-md:w-full max-md:border-r-0">
            <div className="flex items-center px-4 pt-4 pb-2 shrink-0">
              <h2 className="font-display text-[14px] font-600 text-text-2 tracking-[-0.01em] flex-1">
                {viewMode === 'sessions' ? 'Sessions' : 'Chatrooms'}
              </h2>
              {viewMode === 'chatrooms' && (
                <button
                  onClick={() => {
                    useChatroomStore.getState().setEditingChatroomId(null)
                    useChatroomStore.getState().setChatroomSheetOpen(true)
                  }}
                  className="flex items-center gap-1 px-2 py-1 rounded-[6px] text-[11px] font-600 text-accent-bright bg-accent-soft hover:bg-accent-bright/15 transition-all cursor-pointer"
                  style={{ fontFamily: 'inherit' }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  New
                </button>
              )}
            </div>
            <div className="flex items-center gap-1 px-3 pb-2 shrink-0">
              {(['chatrooms', 'sessions'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setViewMode(mode)}
                  data-active={viewMode === mode || undefined}
                  className="rounded-[8px] border-none px-3 py-1.5 text-[11px] font-600 capitalize cursor-pointer transition-all focus-visible:ring-1 focus-visible:ring-accent-bright/50
                    data-[active]:bg-accent-soft data-[active]:text-accent-bright
                    bg-transparent text-text-3 hover:text-text-2 hover:bg-white/[0.04]"
                >
                  {mode}
                </button>
              ))}
            </div>
            <ChatroomList viewMode={viewMode} onSelectRoom={() => setMobileChatOpen(true)} />
          </div>
        )}
        {showChat && (
          <ChatroomView onBack={isDesktop ? undefined : () => setMobileChatOpen(false)} />
        )}
      </div>
    </MainContent>
  )
}
