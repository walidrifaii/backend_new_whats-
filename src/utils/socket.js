let io = null;

const setSocketIO = (socketIO) => {
  io = socketIO;
};

const getSocketIO = () => io;

const emitToClient = (clientId, event, data) => {
  if (io) {
    io.to(`client-${clientId}`).emit(event, data);
  }
};

const emitToUser = (userId, event, data) => {
  if (io) {
    io.to(`user-${userId}`).emit(event, data);
  }
};

module.exports = { setSocketIO, getSocketIO, emitToClient, emitToUser };
