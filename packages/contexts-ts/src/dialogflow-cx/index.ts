import { DialogFlowCXContext } from './dialogflow-cx.class'

/**
 * Crear instancia de clase Bot
 * @param {*} args
 * @returns
 */
const createBotDialog = async ({ database, provider }, _options) =>
    new DialogFlowCXContext(database, provider, _options)

module.exports = {
    createBotDialog,
    DialogFlowCXContext,
}
