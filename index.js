const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const { createSticker } = require('wa-sticker-formatter');
const qrcode = require('qrcode-terminal');

// Estado de los grupos
const gruposConfig = {};
const userLevels = {}; // {groupId: {userId: {xp: 0, level: 1, messages: 0}}}
const muteados = {}; // {groupId: {userId: timestamp}}
const spamControl = {}; // {groupId: {userId: {messages: [], warnings: 0}}}

// CONFIGURA TU NÚMERO AQUÍ (tu número de vendedor/admin principal)
const NUMERO_VENDEDOR = '5212345678901'; // CAMBIA ESTO por tu número con código de país (ej: 52 para México)

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ['Bot Ventas', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n📱 Escanea este código QR con tu WhatsApp Business:\n');
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada. Reconectando...', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ ¡Bot conectado y listo!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // BIENVENIDA A NUEVOS MIEMBROS
    sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
        if (action === 'add') {
            for (const participant of participants) {
                const bienvenida = `👋 ¡Bienvenido al grupo!

Hola @${participant.split('@')[0]} 🎉

📋 *Reglas importantes:*
• Respeta a todos los miembros
• No spam ni publicidad externa
• Usa los comandos del bot para información

💡 Escribe *.menu* para ver los comandos disponibles

¡Esperamos que disfrutes tu estancia! 🚀`;

                await sock.sendMessage(id, {
                    text: bienvenida,
                    mentions: [participant]
                });
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        
        if (!msg.message || msg.key.fromMe) return;
        
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        
        if (!isGroup) return;
        
        const sender = msg.key.participant || msg.key.remoteJid;
        const body = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || 
                     msg.message.imageMessage?.caption || '';
        
        if (!body) return;
        
        // Inicializar config del grupo
        if (!gruposConfig[from]) {
            gruposConfig[from] = { abierto: true, antilinks: true, antispam: true };
        }
        if (!userLevels[from]) {
            userLevels[from] = {};
        }
        if (!spamControl[from]) {
            spamControl[from] = {};
        }
        if (!muteados[from]) {
            muteados[from] = {};
        }
        
        // Obtener metadata del grupo
        const groupMetadata = await sock.groupMetadata(from);
        const participants = groupMetadata.participants;
        const isAdmin = participants.find(p => p.id === sender)?.admin !== null;
        const botIsAdmin = participants.find(p => p.id === sock.user.id)?.admin !== null;
        
        // VERIFICAR SI ESTÁ MUTEADO
        if (muteados[from][sender]) {
            const muteEnd = muteados[from][sender];
            if (Date.now() < muteEnd) {
                if (botIsAdmin) {
                    await sock.sendMessage(from, { delete: msg.key });
                }
                return;
            } else {
                delete muteados[from][sender];
            }
        }
        
        // ANTI-LINKS (detectar enlaces)
        if (gruposConfig[from].antilinks && !isAdmin) {
            const linkRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([^\s]+\.(com|net|org|io|me|co|app|gg))/gi;
            if (linkRegex.test(body)) {
                if (botIsAdmin) {
                    await sock.sendMessage(from, { delete: msg.key });
                    await sock.sendMessage(from, {
                        text: `🚫 @${sender.split('@')[0]}, no se permiten enlaces en este grupo.`,
                        mentions: [sender]
                    });
                }
                return;
            }
        }
        
        // ANTI-SPAM (detectar mensajes repetidos rápidamente)
        if (gruposConfig[from].antispam && !isAdmin) {
            if (!spamControl[from][sender]) {
                spamControl[from][sender] = { messages: [], warnings: 0 };
            }
            
            const now = Date.now();
            const userSpam = spamControl[from][sender];
            
            // Limpiar mensajes antiguos (más de 10 segundos)
            userSpam.messages = userSpam.messages.filter(time => now - time < 10000);
            
            // Agregar mensaje actual (contar también stickers y multimedia)
            userSpam.messages.push(now);
            
            // Si envió 5+ mensajes/stickers en 10 segundos = SPAM
            if (userSpam.messages.length >= 5) {
                userSpam.warnings++;
                
                if (botIsAdmin) {
                    await sock.sendMessage(from, { delete: msg.key });
                    
                    if (userSpam.warnings >= 3) {
                        // Mutear por 5 minutos después de 3 advertencias
                        muteados[from][sender] = Date.now() + (5 * 60 * 1000);
                        await sock.sendMessage(from, {
                            text: `🔇 @${sender.split('@')[0]} ha sido silenciado por 5 minutos por spam.`,
                            mentions: [sender]
                        });
                        userSpam.messages = [];
                        userSpam.warnings = 0;
                    } else {
                        await sock.sendMessage(from, {
                            text: `⚠️ @${sender.split('@')[0]}, evita el spam. Advertencia ${userSpam.warnings}/3`,
                            mentions: [sender]
                        });
                    }
                }
                userSpam.messages = [];
                return;
            }
        }
        
        // SISTEMA DE NIVELES (ganar XP por mensajes)
        if (!userLevels[from][sender]) {
            userLevels[from][sender] = { xp: 0, level: 1, messages: 0 };
        }
        
        const userLevel = userLevels[from][sender];
        userLevel.messages++;
        
        // Ganar XP (10-25 XP aleatorio por mensaje)
        const xpGain = Math.floor(Math.random() * 16) + 10;
        userLevel.xp += xpGain;
        
        // Cálculo de nivel: nivel = raíz cuadrada de (XP / 100)
        const requiredXP = userLevel.level * userLevel.level * 100;
        
        if (userLevel.xp >= requiredXP) {
            userLevel.level++;
            await sock.sendMessage(from, {
                text: `🎉 ¡Felicidades @${sender.split('@')[0]}! Subiste al nivel ${userLevel.level} 🚀`,
                mentions: [sender]
            });
        }
        
        // COMANDO .delete (borrar mensaje)
        if (body === '.delete' || body === '.del') {
            if (!isAdmin) {
                await sock.sendMessage(from, { 
                    text: '❌ Solo los administradores pueden usar este comando.' 
                }, { quoted: msg });
                return;
            }
            
            if (!botIsAdmin) {
                await sock.sendMessage(from, { 
                    text: '❌ Necesito ser administrador para borrar mensajes.' 
                }, { quoted: msg });
                return;
            }
            
            const quotedMsg = msg.message.extendedTextMessage?.contextInfo;
            if (!quotedMsg) {
                await sock.sendMessage(from, { 
                    text: '⚠️ Responde al mensaje que quieres borrar con .delete' 
                }, { quoted: msg });
                return;
            }
            
            try {
                const messageKey = {
                    remoteJid: from,
                    fromMe: false,
                    id: quotedMsg.stanzaId,
                    participant: quotedMsg.participant
                };
                
                await sock.sendMessage(from, { delete: messageKey });
                await sock.sendMessage(from, { delete: msg.key }); // Borrar también el comando
                await sock.sendMessage(from, { 
                    text: '🗑️ Mensaje eliminado.' 
                });
            } catch (error) {
                console.error('Error borrando mensaje:', error);
                await sock.sendMessage(from, { 
                    text: '❌ No pude borrar el mensaje.' 
                }, { quoted: msg });
            }
        }
        
        // COMANDO .hytale
        if (body === '.hytale' || body === '.tutorial') {
            const textoTutorial = `🎮 *TUTORIAL DE COMPRA HYTALE*

💳 *DATOS:*
426807034711xxxx|05|2027|xxx ccv 000

📝 *PASOS:*

1️⃣ Sacas live de amazon mx y te vas a la pagina de hytale, te registras y le das a purchase.

2️⃣ Le das a comprar al plan standard (el mas barato, ya luego puedes actualizarlo al más caro) y pagas con la live con ccv 000 con nombre y cp fakes pero que el cp si exista.

3️⃣ Te pueden salir 2 tipos de 3d:

🔹 *PRIMER 3D (EL BUENO):*
Si en la misma pagina en un cuadro pequeño te aparece lo de coppel, le das abajo a la izquierda en salir y hay chance de que al terminar de cargar te haga la compra sin pedos.

🔹 *SEGUNDO 3D:*
Cuando en otra pagina y con la pantalla completa te carga lo de coppel, ahí ps igual le das en salir pero lo mas probable es que si te sale eso te de pagó rechazado, igual hay veces que pasa la compra sin que tire 3d. O hay veces que parece que va a cargar ese 3d pero se queda cargando, lo brinca y ya te hace la compra.

⚠️ *SI FALLA:*
Es cuestión de ir calando nomas solo que ps si es mejor tener buenas lives, pq si no despues de varios intentos te puede salir un error donde ya no te acepta el pago, osea ni si quiera carga el 3d y solo te dice que hubo un problema con el pagó.

🔧 *SOLUCIÓN SI NO ACEPTA PAGO:*
• Borras historial y todos los datos del navegador
• Lo reestableces y lo cierras
• Si tienes IP dinámica (como Telmex) apagas y prendes el modem
• Si no, compartes datos desde el phon a tu pc y vuelves a calar

💡 Es cuestión de práctica, sigue intentando!`;

            // Primero envía el texto
            await sock.sendMessage(from, { 
                text: textoTutorial 
            });
            
            // Luego envía el video
            // OPCIÓN 1: Si tienes el video en tu carpeta del proyecto
            try {
                const videoPath = '/hytale_tutorial.mp4'; // Coloca el video en tu carpeta
                
                if (fs.existsSync(videoPath)) {
                    const videoBuffer = fs.readFileSync(videoPath);
                    await sock.sendMessage(from, {
                        video: videoBuffer,
                        caption: '🎮 Tutorial completo de compra',
                        mimetype: 'video/mp4'
                    });
                } else {
                    await sock.sendMessage(from, { 
                        text: '⚠️ El video tutorial no está disponible. Contacta al admin.' 
                    });
                }
            } catch (error) {
                console.error('Error enviando video:', error);
                await sock.sendMessage(from, { 
                    text: '❌ Error al enviar el video. Intenta de nuevo más tarde.' 
                });
            }
        }
        
        // Si el grupo está cerrado y no es admin ni comando
        if (!gruposConfig[from].abierto && !isAdmin && !body.startsWith('.')) {
            if (botIsAdmin) {
                await sock.sendMessage(from, { delete: msg.key });
            }
            return;
        }
        
        // COMANDO .kick
        if (body.startsWith('.kick')) {
            if (!isAdmin) {
                await sock.sendMessage(from, { 
                    text: '❌ Solo los administradores pueden usar este comando.' 
                }, { quoted: msg });
                return;
            }
            
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
            if (!mentioned || mentioned.length === 0) {
                await sock.sendMessage(from, { 
                    text: '⚠️ Menciona al usuario que quieres expulsar.\nEjemplo: .kick @usuario' 
                }, { quoted: msg });
                return;
            }
            
            if (!botIsAdmin) {
                await sock.sendMessage(from, { 
                    text: '❌ Necesito ser administrador para expulsar usuarios.' 
                }, { quoted: msg });
                return;
            }
            
            try {
                await sock.groupParticipantsUpdate(from, mentioned, 'remove');
                await sock.sendMessage(from, { 
                    text: '✅ Usuario expulsado del grupo.' 
                }, { quoted: msg });
            } catch (error) {
                await sock.sendMessage(from, { 
                    text: '❌ No pude expulsar al usuario.' 
                }, { quoted: msg });
            }
        }
        
        // COMANDO .admin
        if (body.startsWith('.admin')) {
            if (!isAdmin) {
                await sock.sendMessage(from, { 
                    text: '❌ Solo los administradores pueden usar este comando.' 
                }, { quoted: msg });
                return;
            }
            
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
            if (!mentioned || mentioned.length === 0) {
                await sock.sendMessage(from, { 
                    text: '⚠️ Menciona al usuario que quieres hacer admin.\nEjemplo: .admin @usuario' 
                }, { quoted: msg });
                return;
            }
            
            if (!botIsAdmin) {
                await sock.sendMessage(from, { 
                    text: '❌ Necesito ser administrador para promover usuarios.' 
                }, { quoted: msg });
                return;
            }
            
            try {
                await sock.groupParticipantsUpdate(from, mentioned, 'promote');
                await sock.sendMessage(from, { 
                    text: '✅ Usuario promovido a administrador.' 
                }, { quoted: msg });
            } catch (error) {
                await sock.sendMessage(from, { 
                    text: '❌ No pude promover al usuario.' 
                }, { quoted: msg });
            }
        }
        
        // COMANDO .cerrar
        if (body === '.cerrar') {
            if (!isAdmin) {
                await sock.sendMessage(from, { 
                    text: '❌ Solo los administradores pueden usar este comando.' 
                }, { quoted: msg });
                return;
            }
            
            gruposConfig[from].abierto = false;
            await sock.sendMessage(from, { 
                text: '🔒 *Grupo cerrado*\nSolo los administradores pueden enviar mensajes.' 
            });
        }
        
        // COMANDO .abrir
        if (body === '.abrir') {
            if (!isAdmin) {
                await sock.sendMessage(from, { 
                    text: '❌ Solo los administradores pueden usar este comando.' 
                }, { quoted: msg });
                return;
            }
            
            gruposConfig[from].abierto = true;
            await sock.sendMessage(from, { 
                text: '🔓 *Grupo abierto*\nTodos pueden enviar mensajes nuevamente.' 
            });
        }
        
        // COMANDO .menu
        if (body === '.menu') {
            const menu = `╔═══════════════════╗
║   📋 *MENÚ DEL BOT*   ║
╚═══════════════════╝

👥 *Comandos de Admins:*
• .kick @usuario - Expulsar miembro
• .admin @usuario - Dar admin
• .cerrar - Cerrar grupo
• .abrir - Abrir grupo
• .mutear @usuario <minutos> - Silenciar usuario
• .desmutear @usuario - Quitar silencio
• .antilinks on/off - Activar/desactivar anti-links
• .antispam on/off - Activar/desactivar anti-spam
• .delete - Borrar mensaje (responde al mensaje)

✨ *Comandos para Todos:*
• .menu - Ver este menú
• .sticker - Convertir imagen a sticker
• .nivel - Ver tu nivel y XP
• .top - Ver top 10 del grupo
• .trato - Obtener contacto del vendedor
• .comprar - Link directo para comprar
• .hytale - Ver tutorial de registro

_Responde con una imagen y escribe .sticker para convertirla_`;
            
            await sock.sendMessage(from, { text: menu }, { quoted: msg });
        }
        
        // COMANDO .sticker
        if (body === '.sticker' || body === '.s') {
            const quotedMsg = msg.message.extendedTextMessage?.contextInfo;
            let imageMsg = msg.message.imageMessage;
            
            // Si responde a una imagen
            if (quotedMsg?.quotedMessage?.imageMessage) {
                imageMsg = quotedMsg.quotedMessage.imageMessage;
            }
            
            if (!imageMsg) {
                await sock.sendMessage(from, { 
                    text: '⚠️ Envía o responde a una imagen con .sticker para convertirla.' 
                }, { quoted: msg });
                return;
            }
            
            try {
                const buffer = await downloadMediaMessage(
                    quotedMsg ? { message: quotedMsg.quotedMessage } : msg,
                    'buffer',
                    {}
                );
                
                const sticker = await createSticker(buffer, {
                    pack: 'Bot Ventas',
                    author: 'Tu Grupo',
                    type: 'default',
                    quality: 50
                });
                
                await sock.sendMessage(from, { sticker: sticker }, { quoted: msg });
            } catch (error) {
                console.error('Error creando sticker:', error);
                await sock.sendMessage(from, { 
                    text: '❌ Error al crear el sticker. Asegúrate de enviar una imagen.' 
                }, { quoted: msg });
            }
        }
        
        // COMANDO .mutear
        if (body.startsWith('.mutear')) {
            if (!isAdmin) {
                await sock.sendMessage(from, { 
                    text: '❌ Solo los administradores pueden usar este comando.' 
                }, { quoted: msg });
                return;
            }
            
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
            if (!mentioned || mentioned.length === 0) {
                await sock.sendMessage(from, { 
                    text: '⚠️ Menciona al usuario que quieres mutear.\nEjemplo: .mutear @usuario 5' 
                }, { quoted: msg });
                return;
            }
            
            const args = body.split(' ');
            const minutos = parseInt(args[2]) || 5;
            
            muteados[from][mentioned[0]] = Date.now() + (minutos * 60 * 1000);
            
            await sock.sendMessage(from, {
                text: `🔇 @${mentioned[0].split('@')[0]} ha sido silenciado por ${minutos} minutos.`,
                mentions: mentioned
            });
        }
        
        // COMANDO .desmutear
        if (body.startsWith('.desmutear')) {
            if (!isAdmin) {
                await sock.sendMessage(from, { 
                    text: '❌ Solo los administradores pueden usar este comando.' 
                }, { quoted: msg });
                return;
            }
            
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
            if (!mentioned || mentioned.length === 0) {
                await sock.sendMessage(from, { 
                    text: '⚠️ Menciona al usuario que quieres desmutear.\nEjemplo: .desmutear @usuario' 
                }, { quoted: msg });
                return;
            }
            
            if (muteados[from][mentioned[0]]) {
                delete muteados[from][mentioned[0]];
                await sock.sendMessage(from, {
                    text: `🔊 @${mentioned[0].split('@')[0]} puede hablar nuevamente.`,
                    mentions: mentioned
                });
            } else {
                await sock.sendMessage(from, { 
                    text: '⚠️ Este usuario no está muteado.' 
                }, { quoted: msg });
            }
        }
        
        // COMANDO .antilinks
        if (body.startsWith('.antilinks')) {
            if (!isAdmin) {
                await sock.sendMessage(from, { 
                    text: '❌ Solo los administradores pueden usar este comando.' 
                }, { quoted: msg });
                return;
            }
            
            const args = body.split(' ');
            if (args[1] === 'on') {
                gruposConfig[from].antilinks = true;
                await sock.sendMessage(from, { text: '🔗 Anti-links activado.' });
            } else if (args[1] === 'off') {
                gruposConfig[from].antilinks = false;
                await sock.sendMessage(from, { text: '🔗 Anti-links desactivado.' });
            } else {
                await sock.sendMessage(from, { 
                    text: '⚠️ Usa: .antilinks on o .antilinks off' 
                }, { quoted: msg });
            }
        }
        
        // COMANDO .antispam
        if (body.startsWith('.antispam')) {
            if (!isAdmin) {
                await sock.sendMessage(from, { 
                    text: '❌ Solo los administradores pueden usar este comando.' 
                }, { quoted: msg });
                return;
            }
            
            const args = body.split(' ');
            if (args[1] === 'on') {
                gruposConfig[from].antispam = true;
                await sock.sendMessage(from, { text: '🛡️ Anti-spam activado.' });
            } else if (args[1] === 'off') {
                gruposConfig[from].antispam = false;
                await sock.sendMessage(from, { text: '🛡️ Anti-spam desactivado.' });
            } else {
                await sock.sendMessage(from, { 
                    text: '⚠️ Usa: .antispam on o .antispam off' 
                }, { quoted: msg });
            }
        }
        
        // COMANDO .nivel
        if (body === '.nivel' || body === '.rank') {
            const userStats = userLevels[from][sender];
            if (!userStats) {
                await sock.sendMessage(from, { 
                    text: '⚠️ Aún no tienes estadísticas.' 
                }, { quoted: msg });
                return;
            }
            
            const nextLevelXP = userStats.level * userStats.level * 100;
            const progress = ((userStats.xp / nextLevelXP) * 100).toFixed(1);
            
            const statsText = `📊 *ESTADÍSTICAS*

👤 Usuario: @${sender.split('@')[0]}
⭐ Nivel: ${userStats.level}
✨ XP: ${userStats.xp}/${nextLevelXP}
📈 Progreso: ${progress}%
💬 Mensajes: ${userStats.messages}`;
            
            await sock.sendMessage(from, {
                text: statsText,
                mentions: [sender]
            });
        }
        
        // COMANDO .top
        if (body === '.top' || body === '.leaderboard') {
            const groupUsers = userLevels[from];
            if (!groupUsers || Object.keys(groupUsers).length === 0) {
                await sock.sendMessage(from, { 
                    text: '⚠️ Aún no hay estadísticas en este grupo.' 
                }, { quoted: msg });
                return;
            }
            
            const sorted = Object.entries(groupUsers)
                .sort((a, b) => b[1].level - a[1].level || b[1].xp - a[1].xp)
                .slice(0, 10);
            
            let topText = '🏆 *TOP 10 DEL GRUPO*\n\n';
            
            sorted.forEach(([userId, stats], index) => {
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
                topText += `${medal} @${userId.split('@')[0]}\n`;
                topText += `   Nivel: ${stats.level} | XP: ${stats.xp}\n\n`;
            });
            
            await sock.sendMessage(from, {
                text: topText,
                mentions: sorted.map(([userId]) => userId)
            });
        }
        
        // COMANDO .trato o .comprar
        if (body === '.trato' || body === '.comprar' || body === '.contacto') {
            const linkWhatsApp = `https://wa.me/${NUMERO_VENDEDOR}`;
            
            const mensaje = `💼 *CONTACTAR AL VENDEDOR*

Hola @${sender.split('@')[0]} 👋

Para realizar tu compra o hacer un trato, contacta directamente con el vendedor:

📱 Click aquí: ${linkWhatsApp}

O también puedes enviar un mensaje a:
wa.me/${NUMERO_VENDEDOR}

¡Estamos para servirte! 🛒✨`;
            
            await sock.sendMessage(from, {
                text: mensaje,
                mentions: [sender]
            });
        }
    });

    return sock;
}

connectToWhatsApp();