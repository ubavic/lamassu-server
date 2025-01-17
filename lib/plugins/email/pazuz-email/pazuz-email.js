const https = require('https')
const axios = require('axios').create({
  // TODO: get rejectUnauthorized true to work
  baseURL: `${process.env.PAZUZ_SERVICES_API_URL}`,
  httpsAgent: new https.Agent({
    rejectUnauthorized: false
  })
})

const NAME = 'Pazuz'

function sendMessage (account, rec) {
  return axios.post(`/api/email/send`, {
    message: rec
  })
    .then(({ data }) => {
      if (data.error) throw new Error(JSON.stringify(data.error))
      return
    })
}

module.exports = {
  NAME,
  sendMessage
}
