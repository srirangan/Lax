// @flow
import net from 'net'
import irc from 'slate-irc'
import { getConnectionById } from '../reducers/selectors'
import { credentialsToId } from '../reducers/credentials'
import { commandJoin } from './conversations'
import equalNames from '../modules/equalNames'
import type { Thunk, CredentialsT, ConnectionT, Dispatch } from '../flow'

export const connectToServer = (credentials: CredentialsT): Thunk => {
  return (dispatch, getState) => {
    const id = credentialsToId(credentials)
    const stream = createIrcStream(credentials, dispatch, () => {
      const { connection } = getState().creator

      dispatch({
        type: 'REQUEST_CONNECTION_SUCCESS',
        connection: Object.assign({}, connection, {
          isConnected: true
        })
      })
      dispatch({
        type: 'WORKING_CREDENTIALS',
        credentials
      })
    })

    dispatch({
      type: 'REQUEST_CONNECTION_PENDING',
      connection: {
        id,
        isConnected: false,
        isWelcome: false,
        credentials: credentials,
        stream,
        error: null,
        conversations: null
      }
    })
  }
}

export const reconnect = (credentials: CredentialsT): Thunk => {
  return (dispatch, getState) => {
    const id = credentialsToId(credentials)
    const stream = createIrcStream(credentials, dispatch, () => {
      let conn = getConnectionById(getState(), id)
      if (conn) {
        if (conn.conversations) {
          conn = Object.assign({}, conn, {
            conversations: conn.conversations.map(convo =>
              Object.assign({}, convo, { receivedJoin: false })
            )
          })
        }
        dispatch({
          type: 'REQUEST_CONNECTION_SUCCESS',
          connection: Object.assign({}, conn, {
            isConnected: true
          })
        })
        if (conn.conversations) {
          conn.conversations
            .toArray()
            .filter(convo => convo.type === 'CHANNEL')
            .forEach(convo => {
              commandJoin(id, convo.name)
            })
        }
      }
    })

    const conn = getConnectionById(getState(), id)
    if (conn) {
      dispatch({
        type: 'REQUEST_RECONNECTION',
        connection: conn
      })
    }
  }
}

function createIrcStream(
  credentials: CredentialsT,
  dispatch: Dispatch,
  onConnect: void => void
) {
  const { realName, nickname, password, server, port } = credentials
  const id = credentialsToId(credentials)

  let socket = net.connect({
    port,
    host: server
  })

  socket
    .setTimeout(1000)
    .on('timeout', () => {
      dispatch({
        type: 'REQUEST_CONNECTION_ERROR',
        connectionId: id,
        error: 'net.Socket timeout'
      })
    })
    .on('end', e => {
      console.log('socket end', e)
    })
    .on('connect', e => {
      onConnect()
    })
    .on('close', e => {
      // TODO: figure out how to recover
      // probably want to look at like window focus or "internet is back" events of some sort
      // then check for `ECONNRESET` errors and rebuild the stream(s)
      console.log('socket close', e)
      dispatch({
        type: 'CONNECTION_CLOSED',
        connectionId: id
      })
    })
    .on('error', e => {
      console.log('socket error', e)
      dispatch({
        type: 'REQUEST_CONNECTION_ERROR',
        connectionId: id,
        error: e.message
      })
    })

  let stream = irc(socket)

  if (password) stream.pass(password)
  stream.nick(nickname)
  stream.user(nickname, realName)
  stream.on('errors', e => {
    dispatch({ type: 'IRC_ERROR', connectionId: id, message: e.message })
  })

  stream.on('mode', e => {
    console.log('mode', e)
  })

  stream.on('invite', e => {
    console.log('invite', e)
  })

  stream.on('notice', e => {
    const channelInMessage = getChannelFromNotice(e.message)

    var to, message
    if (channelInMessage) {
      let splitMessage = e.message.split(' ')
      splitMessage.shift() // remove leading channel name

      to = channelInMessage
      message = splitMessage.join(' ')
    } else {
      to = e.to
      message = e.message
    }

    dispatch({
      type: 'RECEIVE_NOTICE',
      connectionId: id,
      from: e.from,
      to,
      message
    })
  })

  stream.on('away', e => {
    dispatch({
      type: 'RECEIVE_AWAY',
      connectionId: id,
      nick: e.nick,
      message: e.message
    })
  })

  stream.on('part', e => {
    dispatch({
      type: 'RECEIVE_PART',
      connectionId: id,
      nick: e.nick,
      message: e.message,
      channels: e.channels
    })
  })

  stream.on('quit', e => {
    dispatch({
      type: 'RECEIVE_QUIT',
      connectionId: id,
      nick: e.nick,
      message: e.message
    })
  })

  stream.on('kick', e => {
    console.log('kick', e)
  })

  stream.on('motd', e => {
    dispatch({
      type: 'RECEIVE_MOTD',
      connectionId: id,
      motd: e.motd.join('\n')
    })
  })

  stream.on('welcome', nick => {
    dispatch({
      type: 'RECEIVE_WELCOME',
      connectionId: id,
      nick
    })
  })

  stream.on('nick', e => {
    dispatch({
      type: 'RECEIVE_NICK',
      connectionId: id,
      oldNickname: e.nick,
      newNickname: e.new
    })
  })

  stream.on('topic', e => {
    dispatch({
      type: 'RECEIVE_TOPIC',
      connectionId: id,
      channel: e.channel,
      topic: e.topic
    })
  })

  stream.on('join', e => {
    dispatch({
      type: 'RECEIVE_JOIN',
      connectionId: id,
      channel: e.channel,
      from: e.nick
    })
  })

  stream.on('names', e => {
    dispatch({
      type: 'RECEIVE_NAMES',
      connectionId: id,
      channel: e.channel,
      names: e.names
    })
  })

  stream.on('message', e => {
    if (e.message.trim().startsWith('\u0001ACTION')) {
      dispatch({
        type: 'RECEIVE_ACTION',
        connectionId: id,
        channel: equalNames(e.to, nickname) ? e.from : e.to,
        from: e.from,
        message: `${e.from} ${e.message
          .replace(/^\u0001ACTION /, '')
          .replace(/\u0001$/, '')}`
      })
    } else if (equalNames(e.to, nickname)) {
      dispatch({
        type: 'RECEIVE_DIRECT_MESSAGE',
        connectionId: id,
        from: e.from,
        message: e.message
      })
    } else {
      dispatch({
        type: 'RECEIVE_CHANNEL_MESSAGE',
        connectionId: id,
        channel: e.to,
        from: e.from,
        message: e.message
      })
    }
  })
  return stream
}

const leadingChannelName = /^\[(#\S+)\]/
function getChannelFromNotice(message) {
  const match = message.match(leadingChannelName)
  return match ? match[1] : null
}
