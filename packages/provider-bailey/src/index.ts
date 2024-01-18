import { ProviderClass, utils } from '@bot-whatsapp/bot'
import { Vendor } from '@bot-whatsapp/bot/dist/provider/providerClass'
import { Boom } from '@hapi/boom'
import { Console } from 'console'
import { createWriteStream, readFileSync, existsSync, PathOrFileDescriptor } from 'fs'
import mime from 'mime-types'
import { join } from 'path'
import pino from 'pino'
import { rimraf } from 'rimraf'
import { IStickerOptions, Sticker } from 'wa-sticker-formatter'

import {
    AnyMediaMessageContent,
    AnyMessageContent,
    BaileysEventMap,
    DisconnectReason,
    PollMessageOptions,
    WASocket,
    getAggregateVotesInPollMessage,
    makeCacheableSignalKeyStore,
    makeInMemoryStore,
    makeWASocketOther,
    proto,
    useMultiFileAuthState,
} from './bailley'
import { GlobalVendorArgs, SendOptions } from './type'
import { baileyGenerateImage, baileyCleanNumber, baileyIsValidNumber } from './utils'

const logger = new Console({
    stdout: createWriteStream(`${process.cwd()}/baileys.log`),
})

class BaileysProvider extends ProviderClass {
    globalVendorArgs: GlobalVendorArgs = { name: `bot`, gifPlayback: false, usePairingCode: false, phoneNumber: null }
    vendor: Vendor<WASocket>
    store?: ReturnType<typeof makeInMemoryStore>
    saveCredsGlobal: (() => Promise<void>) | null = null

    constructor(args: Partial<GlobalVendorArgs>) {
        super()
        this.store = null
        this.globalVendorArgs = { ...this.globalVendorArgs, ...args }
        this.initBailey().then()
    }

    /**
     * Iniciar todo Bailey
     */
    protected initBailey = async () => {
        const NAME_DIR_SESSION = `${this.globalVendorArgs.name}_sessions`
        const { state, saveCreds } = await useMultiFileAuthState(NAME_DIR_SESSION)
        const loggerBaileys = pino({ level: 'fatal' })

        this.saveCredsGlobal = saveCreds

        this.store = makeInMemoryStore({ logger: loggerBaileys })
        this.store.readFromFile(`${NAME_DIR_SESSION}/baileys_store.json`)
        setInterval(() => {
            const path = `${NAME_DIR_SESSION}/baileys_store.json`
            if (existsSync(NAME_DIR_SESSION)) {
                this.store.writeToFile(path)
            }
        }, 10_000)

        try {
            const sock = makeWASocketOther({
                logger: loggerBaileys,
                printQRInTerminal: false,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, loggerBaileys),
                },
                browser: ['Chrome (Linux)', '', ''],
                syncFullHistory: false,
                generateHighQualityLinkPreview: true,
                getMessage: this.getMessage,
            })

            this.store?.bind(sock.ev)

            if (this.globalVendorArgs.usePairingCode && !sock.authState.creds.registered) {
                if (this.globalVendorArgs.phoneNumber) {
                    await sock.waitForConnectionUpdate((update) => !!update.qr)
                    const code = await sock.requestPairingCode(this.globalVendorArgs.phoneNumber)
                    this.emit('require_action', {
                        instructions: [
                            `Acepta la notificación del WhatsApp ${this.globalVendorArgs.phoneNumber} en tu celular 👌`,
                            `El token para la vinculación es: ${code}`,
                            `Necesitas ayuda: https://link.codigoencasa.com/DISCORD`,
                        ],
                    })
                } else {
                    this.emit('auth_failure', [
                        `No se ha definido el numero de telefono agregalo`,
                        `Reinicia el BOT`,
                        `Tambien puedes mirar un log que se ha creado baileys.log`,
                        `Necesitas ayuda: https://link.codigoencasa.com/DISCORD`,
                        `(Puedes abrir un ISSUE) https://github.com/codigoencasa/bot-whatsapp/issues/new/choose`,
                    ])
                }
            }

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update

                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode

                /** Conexion cerrada por diferentes motivos */
                if (connection === 'close') {
                    if (statusCode !== DisconnectReason.loggedOut) {
                        this.initBailey()
                    }

                    if (statusCode === DisconnectReason.loggedOut) {
                        const PATH_BASE = join(process.cwd(), NAME_DIR_SESSION)
                        await rimraf(PATH_BASE)
                        await this.initBailey()
                    }
                }

                /** Conexion abierta correctamente */
                if (connection === 'open') {
                    const parseNumber = `${sock?.user?.id}`.split(':').shift()
                    const host = { ...sock?.user, phone: parseNumber }
                    this.emit('ready', true)
                    this.emit('host', host)
                    this.initBusEvents(sock)
                }

                /** QR Code */
                if (qr && !this.globalVendorArgs.usePairingCode) {
                    this.emit('require_action', {
                        instructions: [
                            `Debes escanear el QR Code 👌 ${this.globalVendorArgs.name}.qr.png`,
                            `Recuerda que el QR se actualiza cada minuto `,
                            `Necesitas ayuda: https://link.codigoencasa.com/DISCORD`,
                        ],
                    })
                    await baileyGenerateImage(qr, `${this.globalVendorArgs.name}.qr.png`)
                }
            })

            sock.ev.on('creds.update', async () => {
                await saveCreds()
            })
        } catch (e) {
            logger.log(e)
            this.emit('auth_failure', [
                `Algo inesperado ha ocurrido NO entres en pánico`,
                `Reinicia el BOT`,
                `Tambien puedes mirar un log que se ha creado baileys.log`,
                `Necesitas ayuda: https://link.codigoencasa.com/DISCORD`,
                `(Puedes abrir un ISSUE) https://github.com/codigoencasa/bot-whatsapp/issues/new/choose`,
            ])
        }
    }

    /**
     * Mapeamos los eventos nativos a los que la clase Provider espera
     * para tener un standar de eventos
     * @returns
     */
    protected busEvents = (): { event: keyof BaileysEventMap; func: (arg?: any, arg2?: any) => any }[] => [
        {
            event: 'messages.upsert',
            func: ({ messages, type }) => {
                if (type !== 'notify') return
                const [messageCtx] = messages

                if (messageCtx?.message?.protocolMessage?.type === 'EPHEMERAL_SETTING') return

                let payload = {
                    ...messageCtx,
                    body: messageCtx?.message?.extendedTextMessage?.text ?? messageCtx?.message?.conversation,

                    from: messageCtx?.key?.remoteJid,
                }

                //Detectar location
                if (messageCtx.message?.locationMessage) {
                    const { degreesLatitude, degreesLongitude } = messageCtx.message.locationMessage
                    if (typeof degreesLatitude === 'number' && typeof degreesLongitude === 'number') {
                        payload = { ...payload, body: utils.generateRefprovider('_event_location_') }
                    }
                }

                //Detectar video
                if (messageCtx.message?.videoMessage) {
                    payload = { ...payload, body: utils.generateRefprovider('_event_media_') }
                }

                //Detectar Sticker
                if (messageCtx.message?.stickerMessage) {
                    payload = { ...payload, body: utils.generateRefprovider('_event_media_') }
                }

                //Detectar media
                if (messageCtx.message?.imageMessage) {
                    payload = { ...payload, body: utils.generateRefprovider('_event_media_') }
                }

                //Detectar file
                if (messageCtx.message?.documentMessage) {
                    payload = { ...payload, body: utils.generateRefprovider('_event_document_') }
                }

                //Detectar voice note
                if (messageCtx.message?.audioMessage) {
                    payload = { ...payload, body: utils.generateRefprovider('_event_voice_note_') }
                }

                if (payload.from === 'status@broadcast') return

                if (payload?.key?.fromMe) return

                if (!baileyIsValidNumber(payload.from)) {
                    return
                }

                const btnCtx = payload?.message?.buttonsResponseMessage?.selectedDisplayText
                if (btnCtx) payload.body = btnCtx

                const listRowId = payload?.message?.listResponseMessage?.title
                if (listRowId) payload.body = listRowId

                payload.from = baileyCleanNumber(payload.from, true)
                this.emit('message', payload)
            },
        },
        {
            event: 'messages.update',
            func: async (message) => {
                for (const { key, update } of message) {
                    if (update.pollUpdates) {
                        const pollCreation = await this.getMessage(key)
                        if (pollCreation) {
                            const pollMessage = getAggregateVotesInPollMessage({
                                message: pollCreation,
                                pollUpdates: update.pollUpdates,
                            })
                            const [messageCtx] = message

                            const messageOriginalKey = messageCtx?.update?.pollUpdates[0]?.pollUpdateMessageKey
                            const messageOriginal = await this.store.loadMessage(
                                messageOriginalKey.remoteJid,
                                messageOriginalKey.id
                            )

                            const payload = {
                                ...messageCtx,
                                body: pollMessage.find((poll) => poll.voters.length > 0)?.name || '',
                                from: baileyCleanNumber(key.remoteJid, true),
                                pushName: messageOriginal?.pushName,
                                broadcast: messageOriginal?.broadcast,
                                messageTimestamp: messageOriginal?.messageTimestamp,
                                voters: pollCreation,
                                type: 'poll',
                            }
                            this.emit('message', payload)
                        }
                    }
                }
            },
        },
    ]

    protected initBusEvents = (_sock: WASocket) => {
        this.vendor = _sock
        const listEvents = this.busEvents()

        for (const { event, func } of listEvents) {
            this.vendor.ev.on(event, func)
        }
    }

    protected getMessage = async (key: { remoteJid: string; id: string }) => {
        if (this.store) {
            const msg = await this.store.loadMessage(key.remoteJid, key.id)
            return msg?.message || undefined
        }
        // only if store is present
        return proto.Message.fromObject({})
    }

    /**
     * @alpha
     * @param {string} number
     * @param {string} message
     * @example await sendMessage('+XXXXXXXXXXX', 'https://dominio.com/imagen.jpg' | 'img/imagen.jpg')
     */

    sendMedia = async (number: string, imageUrl: string, text: string) => {
        const fileDownloaded = await utils.generalDownload(imageUrl)
        const mimeType = mime.lookup(fileDownloaded)

        if (`${mimeType}`.includes('image')) return this.sendImage(number, fileDownloaded, text)
        if (`${mimeType}`.includes('video')) return this.sendVideo(number, fileDownloaded, text)
        if (`${mimeType}`.includes('audio')) {
            const fileOpus = await utils.convertAudio(fileDownloaded)
            return this.sendAudio(number, fileOpus)
        }
        return this.sendFile(number, fileDownloaded)
    }

    /**
     * Enviar imagen
     * @param {*} number
     * @param {*} imageUrl
     * @param {*} text
     * @returns
     */
    sendImage = async (number: string, filePath: PathOrFileDescriptor, text: any) => {
        const payload: AnyMediaMessageContent = {
            image: readFileSync(filePath),
            caption: text,
        }
        return this.vendor.sendMessage(number, payload)
    }

    /**
     * Enviar video
     * @param {*} number
     * @param {*} imageUrl
     * @param {*} text
     * @returns
     */
    sendVideo = async (number: string, filePath: PathOrFileDescriptor, text: any) => {
        const payload: AnyMediaMessageContent = {
            video: readFileSync(filePath),
            caption: text,
            gifPlayback: this.globalVendorArgs.gifPlayback,
        }
        return this.vendor.sendMessage(number, payload)
    }

    /**
     * Enviar audio
     * @alpha
     * @param {string} number
     * @param {string} message
     * @param {boolean} voiceNote optional
     * @example await sendMessage('+XXXXXXXXXXX', 'audio.mp3')
     */

    sendAudio = async (number: string, audioUrl: string) => {
        const payload: AnyMediaMessageContent = {
            audio: { url: audioUrl },
            ptt: true,
        }
        return this.vendor.sendMessage(number, payload)
    }

    /**
     *
     * @param {string} number
     * @param {string} message
     * @returns
     */
    sendText = async (number: string, message: string) => {
        const payload: AnyMessageContent = { text: message }
        return this.vendor.sendMessage(number, payload)
    }

    /**
     *
     * @param {string} number
     * @param {string} filePath
     * @example await sendMessage('+XXXXXXXXXXX', './document/file.pdf')
     */

    sendFile = async (number: string, filePath: string) => {
        const mimeType = mime.lookup(filePath)
        const fileName = filePath.split('/').pop()

        const payload: AnyMessageContent = {
            document: { url: filePath },
            mimetype: `${mimeType}`,
            fileName: fileName,
        }

        return this.vendor.sendMessage(number, payload)
    }

    /**
     *
     * @param {string} number
     * @param {string} text
     * @param {string} footer
     * @param {Array} buttons
     * @example await sendMessage("+XXXXXXXXXXX", "Your Text", "Your Footer", [{"buttonId": "id", "buttonText": {"displayText": "Button"}, "type": 1}])
     */

    sendButtons = async (number: string, text: string, buttons: any[]) => {
        this.emit(
            'notice',
            [
                `[NOTA]: Actualmente enviar botones no esta disponible con este proveedor`,
                `[NOTA]: esta funcion esta disponible con Meta o Twilio`,
            ].join('\n')
        )
        const numberClean = baileyCleanNumber(number)

        const templateButtons = buttons.map((btn: { body: any }, i: any) => ({
            buttonId: `id-btn-${i}`,
            buttonText: { displayText: btn.body },
            type: 1,
        }))

        const buttonMessage = {
            text,
            footer: '',
            buttons: templateButtons,
            headerType: 1,
        }

        return this.vendor.sendMessage(numberClean, buttonMessage)
    }

    /**
     *
     * @param {string} number
     * @param {string} text
     * @param {string} footer
     * @param {Array} poll
     * @example await sendMessage("+XXXXXXXXXXX", { poll: { "name": "You accept terms", "values": [ "Yes", "Not"], "selectableCount": 1 })
     */

    sendPoll = async (numberIn: string, text: string, poll: { options: string[]; multiselect: any }) => {
        const numberClean = baileyCleanNumber(numberIn)

        if (poll.options.length < 2) return false

        const pollMessage: PollMessageOptions = {
            name: text,
            values: poll.options,
            selectableCount: poll?.multiselect === undefined ? 1 : poll?.multiselect ? 1 : 0,
        }
        return this.vendor.sendMessage(numberClean, {
            poll: pollMessage,
        })
    }

    /**
     * TODO: Necesita terminar de implementar el sendMedia y sendButton guiarse:
     * https://github.com/leifermendez/bot-whatsapp/blob/4e0fcbd8347f8a430adb43351b5415098a5d10df/packages/provider/src/web-whatsapp/index.js#L165
     * @param {string} number
     * @param {string} message
     * @example await sendMessage('+XXXXXXXXXXX', 'Hello World')
     */

    async sendMessage(numberIn: string | number, message: string, options: SendOptions = {}): Promise<any> {
        const number = baileyCleanNumber(`${numberIn}`)

        if (options.buttons?.length) return this.sendButtons(number, message, options.buttons)
        if (options.media) return this.sendMedia(number, options.media, message)
        return this.sendText(number, message)
    }

    /**
     * @param {string} remoteJid
     * @param {string} latitude
     * @param {string} longitude
     * @param {any} messages
     * @example await sendLocation("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "xx.xxxx", "xx.xxxx", messages)
     */

    sendLocation = async (remoteJid: string, latitude: any, longitude: any, messages: any = null) => {
        await this.vendor.sendMessage(
            remoteJid,
            {
                location: {
                    degreesLatitude: latitude,
                    degreesLongitude: longitude,
                },
            },
            { quoted: messages }
        )

        return { status: 'success' }
    }

    /**
     * @param {string} remoteJid
     * @param {string} contactNumber
     * @param {string} displayName
     * @param {any} messages - optional
     * @example await sendContact("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "+xxxxxxxxxxx", "Robin Smith", messages)
     */

    sendContact = async (
        remoteJid: any,
        contactNumber: { replaceAll: (arg0: string, arg1: string) => any },
        displayName: any,
        messages: any = null
    ) => {
        const cleanContactNumber = contactNumber.replaceAll(' ', '')
        const waid = cleanContactNumber.replace('+', '')

        const vcard =
            'BEGIN:VCARD\n' +
            'VERSION:3.0\n' +
            `FN:${displayName}\n` +
            'ORG:Ashoka Uni;\n' +
            `TEL;type=CELL;type=VOICE;waid=${waid}:${cleanContactNumber}\n` +
            'END:VCARD'

        await this.vendor.sendMessage(
            remoteJid,
            {
                contacts: {
                    displayName: '.',
                    contacts: [{ vcard }],
                },
            },
            { quoted: messages }
        )

        return { status: 'success' }
    }

    /**
     * @param {string} remoteJid
     * @param {string} WAPresence
     * @example await sendPresenceUpdate("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "recording")
     */
    sendPresenceUpdate = async (remoteJid: any, WAPresence: any) => {
        await this.vendor.sendPresenceUpdate(WAPresence, remoteJid)
    }

    /**
     * @param {string} remoteJid
     * @param {string} url
     * @param {object} stickerOptions
     * @param {any} messages - optional
     * @example await sendSticker("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "https://dn/image.png" || "https://dn/image.gif" || "https://dn/image.mp4", {pack: 'User', author: 'Me'} messages)
     */

    sendSticker = async (
        remoteJid: any,
        url: string | Buffer,
        stickerOptions: Partial<IStickerOptions>,
        messages: any = null
    ) => {
        const sticker = new Sticker(url, {
            ...stickerOptions,
            quality: 50,
            type: 'crop',
        })

        const buffer = await sticker.toMessage()

        await this.vendor.sendMessage(remoteJid, buffer, { quoted: messages })
    }
}

export { BaileysProvider }