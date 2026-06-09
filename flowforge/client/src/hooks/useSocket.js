import { useEffect } from 'react'
import socket from '../services/socket'

export function useSocket(workflowId, { onRemoteNode, onRemoteCursor, onExecUpdate } = {}) {
  useEffect(() => {
    if (!workflowId) return

    socket.auth = { token: localStorage.getItem('token') }
    socket.connect()
    socket.emit('join-workflow', { workflowId })

    if (onRemoteNode) socket.on('remote-node', onRemoteNode)
    if (onRemoteCursor) socket.on('remote-cursor', onRemoteCursor)
    if (onExecUpdate) socket.on('exec-update', onExecUpdate)

    return () => {
      socket.emit('leave-workflow', { workflowId })
      if (onRemoteNode) socket.off('remote-node', onRemoteNode)
      if (onRemoteCursor) socket.off('remote-cursor', onRemoteCursor)
      if (onExecUpdate) socket.off('exec-update', onExecUpdate)
      socket.disconnect()
    }
  }, [workflowId])
}
