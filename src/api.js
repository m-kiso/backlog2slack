'use strict'
const _ = require('lodash')
const Slack = require('slack-node')
const request = require('request-promise-native')
const backlogConst = require('./backlogConst')
const response = require('./response')

const slack = new Slack(process.env.SLACK_API_TOKEN)

module.exports = async (event, context, callback) => {
  if (event.path !== '/notify' || event.httpMethod !== 'POST') {
    return callback(null, response(400))
  }

  const backlog = JSON.parse(event.body)
  if (!backlog || !backlog.id) {
    console.error('cannot parse body:', event.body)
    return callback(null, response(400))
  }

  console.log(`Start ${backlog.project.projectKey}-${backlog.content.key_id}`)

  const [slackUsers] = await Promise.all([
    fetchSlackUsers()
  ])

  const users = []

  // assignee user
  if (backlog.content.assignee) {
    // find backlog mailAddress
    const assigneeUser = await fetchBacklogUser(backlog.content.assignee.id)
    // find slack user by slack user's email
    const slackAssigneeUser = _.find(slackUsers.members, o => o.profile.email === assigneeUser.mailAddress)
    if (slackAssigneeUser) {
      users.push(slackAssigneeUser)
    }
  }

  for (const notification of backlog.notifications) {
    // find backlog mailAddress
    const user = await fetchBacklogUser(notification.user.id)

    // find slack user by slack user's email
    const slackUser = _.find(slackUsers.members, o => o.profile.email === user.mailAddress)
    if (!slackUser) {
      continue
    }

    users.push(slackUser)
  }

  if (users.length === 0) {
    console.log('User not found.')
    return callback(null, response(200, 'OK'))
  }
  const issue = await fetchBacklogIssue(backlog.project.projectKey, backlog.content.key_id)

  console.log(`Start message post to ${users.join(',')}`)
  const message = generateChatMessage(backlog, issue)
  try {
    await postChatMessage(message, users)
    callback(null, response(200, 'OK'))
  } catch (err) {
    callback(null, response(500, err))
  }
}

/**
 * fetch backlog issue
 * @param projectKey
 * @param issueKey
 */
const fetchBacklogIssue = (projectKey, issueKey) =>
  request({
    uri: `${process.env.BACKLOG_BASE_URL}/api/v2/issues/${projectKey}-${issueKey}`,
    qs: {
      apiKey: process.env.BACKLOG_API_KEY
    },
    json: true
  })

/**
 * fetch backlog user
 * @param userId
 */
const fetchBacklogUser = userId =>
  request({
    uri: `${process.env.BACKLOG_BASE_URL}/api/v2/users/${userId}`,
    qs: {
      apiKey: process.env.BACKLOG_API_KEY
    },
    json: true
  })

const fetchSlackChanelId = id =>
  new Promise((resolve, reject) => {
    slack.api('im.open', { user: id }, (err, response) => {
      if (err) {
        console.error(err)
        reject(err)
      } else {
        resolve(response)
      }
    })
  })

/**
 * fetch slack user list
 */
const fetchSlackUsers = () =>
  new Promise((resolve, reject) => {
    slack.api('users.list', (err, response) => {
      if (err) {
        console.error(err)
        reject(err)
      } else {
        resolve(response)
      }
    })
  })

/**
 * generate message payload for slack
 * @param backlogMessage
 * @param backlogIssue
 * @returns {{as_user: boolean, attachments}}
 */
const generateChatMessage = (backlogMessage, backlogIssue) => {
  const backlogKey = `${backlogMessage.project.projectKey}-${backlogMessage.content.key_id}`
  const fields = [
    {
      value: `*状態*: ${backlogIssue.status.name}`,
      short: true
    },
    {
      value: `*優先度*: ${backlogIssue.priority.name}`,
      short: true
    }
  ]

  if (backlogIssue.assignee) {
    fields.push({
      value: `*担当者*: ${backlogIssue.assignee.name}`,
      short: true
    })
  }

  if (backlogIssue.updatedUser) {
    fields.push({
      value: `*更新者*: ${backlogIssue.updatedUser.name}`,
      short: true
    })
  }

  if (backlogMessage.content.comment) {
    fields.push({
      title: 'コメント',
      value: backlogMessage.content.comment.content.replace('\n', ' '),
      short: false
    })
  }

  return {
    as_user: false,
    attachments: JSON.stringify([
      {
        fallback: `Backlog - ${backlogConst.types[backlogMessage.type]}: ${backlogKey} ${backlogMessage.content.summary}`,
        color: backlogConst.statusColors[backlogIssue.status.id],
        pretext: `Backlog - ${backlogConst.types[backlogMessage.type]}`,
        text: `【${backlogIssue.issueType.name}】<${process.env.BACKLOG_BASE_URL}/view/${backlogKey}|${backlogKey}> ${backlogMessage.content.summary}`,
        mrkdwn_in: ['pretext', 'text', 'fields'],
        fields: fields
      }
    ])
  }
}

/**
 * post message to slack
 * @param message
 * @param users
 * @returns {Promise.<*[]>}
 */
const postChatMessage = async (message, users) => {
  const promises = []
  for (const user of users) {
    const im = await fetchSlackChanelId(user.id)
    const payload = _.extend({}, message, { channel: im.channel.id })
    promises.push(new Promise((resolve, reject) => {
      slack.api('chat.postMessage', payload, (err, response) => {
        if (err) {
          console.error(err)
          reject(err)
        } else {
          resolve(response)
        }
      })
    }))
  }
  return Promise.all(promises)
}
