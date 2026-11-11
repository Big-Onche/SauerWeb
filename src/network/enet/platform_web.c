/*
 * Browser socket backend for the unmodified ENet 1.3.17 core bundled with
 * Sauerbraten SVN r6488. WebSocket frames are queued as complete UDP datagrams;
 * ENet remains responsible for channels, reliability, sequencing and retries.
 */

#include <emscripten/emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define ENET_BUILDING_LIB 1
#include "enet/enet.h"

typedef struct datagram
{
    struct datagram *next;
    size_t length;
    enet_uint8 data[1];
} datagram;

static datagram *incoming_head = NULL, *incoming_tail = NULL;
static datagram *outgoing_head = NULL, *outgoing_tail = NULL;
static enet_uint32 time_base = 0;
static enet_uint16 remote_port = 28785;

static void queue_datagram(datagram **head, datagram **tail, const enet_uint8 *data, size_t length)
{
    datagram *item = (datagram *)malloc(sizeof(datagram) + (length ? length - 1 : 0));
    if(!item) return;
    item->next = NULL;
    item->length = length;
    if(length) memcpy(item->data, data, length);
    if(*tail) (*tail)->next = item;
    else *head = item;
    *tail = item;
}

static void clear_queue(datagram **head, datagram **tail)
{
    while(*head)
    {
        datagram *item = *head;
        *head = item->next;
        free(item);
    }
    *tail = NULL;
}

int enet_initialize(void) { return 0; }
void enet_deinitialize(void) {}
enet_uint32 enet_host_random_seed(void) { return (enet_uint32)emscripten_get_now(); }
enet_uint32 enet_time_get(void) { return (enet_uint32)emscripten_get_now() - time_base; }
void enet_time_set(enet_uint32 value) { time_base = (enet_uint32)emscripten_get_now() - value; }

int enet_address_set_host_ip(ENetAddress *address, const char *name)
{
    (void)name;
    address->host = ENET_HOST_TO_NET_32(0x7F000001U);
    return 0;
}

int enet_address_set_host(ENetAddress *address, const char *name) { return enet_address_set_host_ip(address, name); }

int enet_address_get_host_ip(const ENetAddress *address, char *name, size_t name_length)
{
    (void)address;
    if(name_length < 10) return -1;
    memcpy(name, "127.0.0.1", 10);
    return 0;
}

int enet_address_get_host(const ENetAddress *address, char *name, size_t name_length)
{
    return enet_address_get_host_ip(address, name, name_length);
}

ENetSocket enet_socket_create(ENetSocketType type) { return type == ENET_SOCKET_TYPE_DATAGRAM ? 1 : ENET_SOCKET_NULL; }
int enet_socket_bind(ENetSocket socket, const ENetAddress *address) { (void)socket; (void)address; return 0; }
int enet_socket_get_address(ENetSocket socket, ENetAddress *address)
{
    (void)socket;
    address->host = ENET_HOST_ANY;
    address->port = ENET_PORT_ANY;
    return 0;
}
int enet_socket_set_option(ENetSocket socket, ENetSocketOption option, int value) { (void)socket; (void)option; (void)value; return 0; }
int enet_socket_get_option(ENetSocket socket, ENetSocketOption option, int *value) { (void)socket; (void)option; *value = 0; return 0; }
int enet_socket_connect(ENetSocket socket, const ENetAddress *address) { (void)socket; (void)address; return 0; }
void enet_socket_destroy(ENetSocket socket) { (void)socket; }

int enet_socket_send(ENetSocket socket, const ENetAddress *address, const ENetBuffer *buffers, size_t buffer_count)
{
    size_t total = 0, offset = 0, index;
    enet_uint8 *bytes;
    (void)socket;
    (void)address;
    for(index = 0; index < buffer_count; ++index) total += buffers[index].dataLength;
    bytes = (enet_uint8 *)malloc(total);
    if(!bytes) return -1;
    for(index = 0; index < buffer_count; ++index)
    {
        memcpy(bytes + offset, buffers[index].data, buffers[index].dataLength);
        offset += buffers[index].dataLength;
    }
    queue_datagram(&outgoing_head, &outgoing_tail, bytes, total);
    free(bytes);
    return (int)total;
}

int enet_socket_receive(ENetSocket socket, ENetAddress *address, ENetBuffer *buffers, size_t buffer_count)
{
    datagram *item;
    size_t remaining, offset = 0, index;
    (void)socket;
    if(!incoming_head) return 0;
    item = incoming_head;
    incoming_head = item->next;
    if(!incoming_head) incoming_tail = NULL;
    remaining = item->length;
    for(index = 0; index < buffer_count && remaining; ++index)
    {
        size_t amount = buffers[index].dataLength < remaining ? buffers[index].dataLength : remaining;
        memcpy(buffers[index].data, item->data + offset, amount);
        offset += amount;
        remaining -= amount;
    }
    if(address)
    {
        address->host = ENET_HOST_TO_NET_32(0x7F000001U);
        address->port = remote_port;
    }
    index = remaining ? (size_t)-1 : item->length;
    free(item);
    return index == (size_t)-1 ? -1 : (int)index;
}

int enet_socket_wait(ENetSocket socket, enet_uint32 *condition, enet_uint32 timeout)
{
    (void)socket;
    (void)timeout;
    *condition &= incoming_head ? ENET_SOCKET_WAIT_RECEIVE : ENET_SOCKET_WAIT_NONE;
    return 0;
}

int enet_socketset_select(ENetSocket max_socket, ENetSocketSet *read_set, ENetSocketSet *write_set, enet_uint32 timeout)
{
    (void)max_socket; (void)read_set; (void)write_set; (void)timeout;
    return incoming_head ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE void sauer_enet_queue_incoming(const enet_uint8 *data, size_t length)
{
    queue_datagram(&incoming_head, &incoming_tail, data, length);
}

void sauer_enet_set_remote_port(enet_uint16 port) { remote_port = port; }

EMSCRIPTEN_KEEPALIVE const enet_uint8 *sauer_enet_outgoing_data(void) { return outgoing_head ? outgoing_head->data : NULL; }
EMSCRIPTEN_KEEPALIVE size_t sauer_enet_outgoing_length(void) { return outgoing_head ? outgoing_head->length : 0; }

EMSCRIPTEN_KEEPALIVE void sauer_enet_pop_outgoing(void)
{
    datagram *item;
    if(!outgoing_head) return;
    item = outgoing_head;
    outgoing_head = item->next;
    if(!outgoing_head) outgoing_tail = NULL;
    free(item);
}

EMSCRIPTEN_KEEPALIVE void sauer_enet_clear_datagrams(void)
{
    clear_queue(&incoming_head, &incoming_tail);
    clear_queue(&outgoing_head, &outgoing_tail);
}
