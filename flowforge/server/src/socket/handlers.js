function getActiveUsers(io, workflowId) {
  const room = io.sockets.adapter.rooms.get(`workflow:${workflowId}`)
  if (!room) return []
  const users = []
  for (const socketId of room) {
    const s = io.sockets.sockets.get(socketId)
    if (s) {
      users.push({ userId: s.userId, displayName: s.displayName, color: s.color })
    }
  }
  return users
}

module.exports = function registerHandlers(socket, io) {
  socket.on('join-workflow', ({ workflowId }) => {
    socket.join(`workflow:${workflowId}`)
    socket.emit('presence', { users: getActiveUsers(io, workflowId) })
    socket.to(`workflow:${workflowId}`).emit('user-joined', {
      userId: socket.userId,
      displayName: socket.displayName,
      color: socket.color,
    })
  })

  socket.on('leave-workflow', ({ workflowId }) => {
    socket.leave(`workflow:${workflowId}`)
    socket.to(`workflow:${workflowId}`).emit('user-left', { userId: socket.userId })
  })

  socket.on('node-change', ({ workflowId, action, node }) => {
    socket.to(`workflow:${workflowId}`).emit('remote-node', {
      userId: socket.userId,
      action,
      node,
    })
  })

  socket.on('edge-change', ({ workflowId, action, edge }) => {
    socket.to(`workflow:${workflowId}`).emit('remote-edge', {
      userId: socket.userId,
      action,
      edge,
    })
  })

  socket.on('cursor-move', ({ workflowId, x, y }) => {
    socket.to(`workflow:${workflowId}`).emit('remote-cursor', {
      userId: socket.userId,
      color: socket.color,
      x,
      y,
    })
  })

  socket.on('disconnect', () => {
    for (const room of socket.rooms) {
      if (room.startsWith('workflow:')) {
        socket.to(room).emit('user-left', { userId: socket.userId })
      }
    }
  })
}
