import { useEffect, useRef } from 'react'
import socket from '../services/socket'

const EVENT_MAP = {
  'remote-node': 'onRemoteNode',
  'remote-edge': 'onRemoteEdge',
  'remote-cursor': 'onRemoteCursor',
  'exec-update': 'onExecUpdate',
  'presence': 'onPresence',
  'user-joined': 'onUserJoined',
  'user-left': 'onUserLeft',
  'comment-added': 'onCommentAdded',
  'comment-reply-added': 'onCommentReplyAdded',
  'comment-resolved': 'onCommentResolved',
}

// Handlers are kept in a ref so callers can pass fresh closures every render
// without re-running the connect/join effect. Beyond the data events in
// EVENT_MAP, callers may pass onConnectionLost / onReconnect to react to the
// socket dropping and coming back (used to surface a "connection lost" toast).
export function useSocket(workflowId, handlers = {}) {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const lostRef = useRef(false) // true while we believe the connection is down

  useEffect(() => {
    if (!workflowId) return

    socket.auth = { token: localStorage.getItem('token') }
    socket.connect()

    const joinRoom = () => socket.emit('join-workflow', { workflowId })
    const onConnect = () => {
      joinRoom() // (re-)join the room on first connect and after reconnects
      if (lostRef.current) {
        lostRef.current = false
        handlersRef.current.onReconnect?.()
      }
    }
    // Fire onConnectionLost once per outage. Ignore our own intentional
    // disconnect when the effect cleans up (reason 'io client disconnect').
    const onConnectionDown = (reason) => {
      if (reason === 'io client disconnect') return
      if (!lostRef.current) {
        lostRef.current = true
        handlersRef.current.onConnectionLost?.()
      }
    }
    const onConnectError = () => onConnectionDown('connect_error')

    if (socket.connected) joinRoom()
    socket.on('connect', onConnect)
    socket.on('disconnect', onConnectionDown)
    socket.on('connect_error', onConnectError)

    const listeners = Object.entries(EVENT_MAP).map(([event, handlerName]) => {
      const fn = (payload) => handlersRef.current[handlerName]?.(payload)
      socket.on(event, fn)
      return [event, fn]
    })

    return () => {
      socket.emit('leave-workflow', { workflowId })
      socket.off('connect', onConnect)
      socket.off('disconnect', onConnectionDown)
      socket.off('connect_error', onConnectError)
      for (const [event, fn] of listeners) socket.off(event, fn)
      socket.disconnect()
    }
  }, [workflowId])

  return socket
}
