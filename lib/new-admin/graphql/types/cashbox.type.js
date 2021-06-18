const { gql } = require('apollo-server-express')

const typeDef = gql`
  type CashboxBatch {
    id: ID
    deviceId: ID
    created: Date
    operationType: String
    customBillCount: Int
    performedBy: String
    bills: [Bill]
  }

  type Query {
    cashboxBatches: [CashboxBatch]
  }

  type Mutation {
    editBatch(id: ID, performedBy: String): CashboxBatch
  }
`

module.exports = typeDef