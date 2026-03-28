import { indexKnowledge } from '../rag.js';
import { logger } from '../logger.js';

const IG_ROUTING = {
    max: 'healingmotions',
    melini: 'meliniseri'
};

/**
 * Script 100% Libre para minar Perfiles Pblicos de IG va URL + Regex
 * Sin tokens, sin SDKs pesados.
 */
export async function syncInstagramPersona(twin: 'max' | 'melini') {
    const username = IG_ROUTING[twin];
    logger.info(`Sincronizando la mente de ${username} desde Instagram...`);

    try {
        const res = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "x-ig-app-id": "936619743392459" 
            }
        });

        if (!res.ok) throw new Error("Bloqueo de Instagram o cuenta privada");
        const data = await res.json() as any;
        
        const edges = data?.data?.user?.edge_owner_to_timeline_media?.edges || [];
        
        for (const post of edges) {
            const caption = post.node?.edge_media_to_caption?.edges[0]?.node?.text || '';
            if (caption.length > 20) {
                // Ingesta Directamente a tu pipeline actual Qdrant
                await indexKnowledge(twin, caption, `Instagram Post`);
            }
        }
        
        logger.info(`✨ PersonaPlex Actualizado! Qdrant ingestó la esencia reciente de ${username}`);
    } catch (e) {
        logger.warn({ err: e }, `El rate limit de Meta nos detectó para ${username}. Alternativa: Usa rss.app`);
    }
}
