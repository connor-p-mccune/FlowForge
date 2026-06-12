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
}

// Handlers are kept in a ref so callers can pass fresh closures every render
// without re-running the connect/join effect.
export function useSocket(workflowId, handlers = {}) {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    if (!workflowId) return

    socket.auth = { token: localStorage.getItem('token') }
    socket.connect()

    const joinRoom = () => socket.emit('join-workflow', { workflowId })
    if (socket.connected) joinRoom()
    socket.on('connect', joinRoom) // also re-joins after reconnects

    const listeners = Object.entries(EVENT_MAP).map(([event, handlerName]) => {
      const fn = (payload) => handlersRef.current[handlerName]?.(payload)
      socket.on(event, fn)
      return [event, fn]
    })

    return () => {
      socket.emit('leave-workflow', { workflowId })
      socket.off('connect', joinRoom)
      for (const [event, fn] of listeners) socket.off(event, fn)
      socket.disconnect()
    }
  }, [workflowId])

  return socket
}
