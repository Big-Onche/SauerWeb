#include <emscripten/emscripten.h>
#include <stddef.h>

#include "enet/enet.h"

static ENetHost *client_host = NULL;
static ENetPeer *server_peer = NULL;
static ENetEvent current_event;

void sauer_enet_clear_datagrams(void);

EMSCRIPTEN_KEEPALIVE int sauer_enet_create(enet_uint16 port, size_t channels)
{
    ENetAddress address;
    if(client_host) return -1;
    if(enet_initialize() < 0) return -2;
    client_host = enet_host_create(NULL, 1, channels, 0, 0);
    if(!client_host) return -3;
    address.host = ENET_HOST_TO_NET_32(0x7F000001U);
    address.port = port;
    server_peer = enet_host_connect(client_host, &address, channels, 0);
    if(!server_peer)
    {
        enet_host_destroy(client_host);
        client_host = NULL;
        return -4;
    }
    current_event.type = ENET_EVENT_TYPE_NONE;
    current_event.packet = NULL;
    return 0;
}

EMSCRIPTEN_KEEPALIVE int sauer_enet_service(void)
{
    if(!client_host) return -1;
    if(current_event.packet) return current_event.type;
    return enet_host_service(client_host, &current_event, 0) > 0 ? current_event.type : ENET_EVENT_TYPE_NONE;
}

EMSCRIPTEN_KEEPALIVE int sauer_enet_event_channel(void) { return current_event.channelID; }
EMSCRIPTEN_KEEPALIVE int sauer_enet_event_data(void) { return (int)current_event.data; }
EMSCRIPTEN_KEEPALIVE int sauer_enet_event_flags(void) { return current_event.packet ? (int)current_event.packet->flags : 0; }
EMSCRIPTEN_KEEPALIVE const enet_uint8 *sauer_enet_event_packet(void) { return current_event.packet ? current_event.packet->data : NULL; }
EMSCRIPTEN_KEEPALIVE size_t sauer_enet_event_length(void) { return current_event.packet ? current_event.packet->dataLength : 0; }

EMSCRIPTEN_KEEPALIVE void sauer_enet_event_done(void)
{
    if(current_event.packet) enet_packet_destroy(current_event.packet);
    current_event.type = ENET_EVENT_TYPE_NONE;
    current_event.packet = NULL;
}

EMSCRIPTEN_KEEPALIVE int sauer_enet_send(enet_uint8 channel, const enet_uint8 *data, size_t length, enet_uint32 flags)
{
    ENetPacket *packet;
    if(!server_peer) return -1;
    packet = enet_packet_create(data, length, flags);
    if(!packet) return -2;
    if(enet_peer_send(server_peer, channel, packet) < 0)
    {
        enet_packet_destroy(packet);
        return -3;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE void sauer_enet_flush(void) { if(client_host) enet_host_flush(client_host); }

EMSCRIPTEN_KEEPALIVE void sauer_enet_disconnect(enet_uint32 data)
{
    if(server_peer) enet_peer_disconnect(server_peer, data);
}

EMSCRIPTEN_KEEPALIVE void sauer_enet_destroy(void)
{
    sauer_enet_event_done();
    if(client_host) enet_host_destroy(client_host);
    client_host = NULL;
    server_peer = NULL;
    sauer_enet_clear_datagrams();
    enet_deinitialize();
}
