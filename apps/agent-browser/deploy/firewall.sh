#!/bin/bash
# Egress firewall for the cal.diy agent browser container.
# Installed by the owner as /usr/local/sbin/caldiy-agent-browser-firewall.sh and run by
# caldiy-agent-browser-firewall.service after every docker start. Idempotent: it creates the isolated
# network if missing, flushes and refills its own chains, and inserts each jump only once.
#
# The browser opens arbitrary public sites on request of meeting participants, so everything it can
# reach besides the public internet on web ports is rejected: private and reserved ranges, other
# containers, cloud metadata, and the host itself (the app on *:3221 has the live database behind it).
set -euo pipefail

NET=caldiy-agent-browser
BR=br-caldiy-ab
SUBNET=10.213.7.0/24
# eth0 carries the public address; override when the interface differs.
PUBLIC_IF=${CALDIY_AB_PUBLIC_IF:-eth0}

HOST_IP=${CALDIY_AB_HOST_IP:-$(ip -4 -o addr show dev "$PUBLIC_IF" | awk '{print $4}' | cut -d/ -f1 | head -1)}
if [ -z "$HOST_IP" ]; then
  echo "no IPv4 address on $PUBLIC_IF; set CALDIY_AB_HOST_IP" >&2
  exit 1
fi

if ! docker network inspect "$NET" > /dev/null 2>&1; then
  docker network create --driver bridge --subnet "$SUBNET" \
    -o com.docker.network.bridge.name="$BR" \
    -o com.docker.network.bridge.enable_icc=false \
    "$NET" > /dev/null
fi

# Private, shared (CGNAT, incl. tailscale), loopback, link-local (incl. 169.254.169.254), documentation,
# benchmarking, multicast and reserved ranges.
BLOCKED="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4"
# Every address the host owns, so the public IP and any future one are rejected on FORWARD too.
HOST_ADDRS=$(ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1 | sort -u)

# Forwarded traffic: the internet, other containers, DNAT'd published ports.
iptables -N CALDIY-AB 2> /dev/null || iptables -F CALDIY-AB
iptables -A CALDIY-AB -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for cidr in $BLOCKED $HOST_ADDRS; do
  # REJECT rather than DROP, so a blocked connection fails fast instead of hanging the browser.
  iptables -A CALDIY-AB -d "$cidr" -p tcp -j REJECT --reject-with tcp-reset
  iptables -A CALDIY-AB -d "$cidr" -j REJECT
done
iptables -A CALDIY-AB -p tcp -m multiport --dports 80,443 -j RETURN
iptables -A CALDIY-AB -p udp -m multiport --dports 53,443 -j RETURN
iptables -A CALDIY-AB -p tcp --dport 53 -j RETURN
iptables -A CALDIY-AB -p tcp -j REJECT --reject-with tcp-reset
iptables -A CALDIY-AB -j REJECT
iptables -C DOCKER-USER -i "$BR" -j CALDIY-AB 2> /dev/null || iptables -I DOCKER-USER 1 -i "$BR" -j CALDIY-AB

# Traffic to the host's own addresses goes through INPUT, not FORWARD, so DOCKER-USER alone would leave
# :3221, :22, :5432 and the rest reachable. Only the public sites behind Caddy stay open.
iptables -N CALDIY-AB-IN 2> /dev/null || iptables -F CALDIY-AB-IN
iptables -A CALDIY-AB-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A CALDIY-AB-IN -d "$HOST_IP" -p tcp -m multiport --dports 80,443 -j ACCEPT
iptables -A CALDIY-AB-IN -p tcp -j REJECT --reject-with tcp-reset
iptables -A CALDIY-AB-IN -j REJECT
iptables -C INPUT -i "$BR" -j CALDIY-AB-IN 2> /dev/null || iptables -I INPUT 1 -i "$BR" -j CALDIY-AB-IN

# The network is created without IPv6; this keeps it that way even if a v6 address appears.
if [ -w "/proc/sys/net/ipv6/conf/$BR/disable_ipv6" ]; then
  echo 1 > "/proc/sys/net/ipv6/conf/$BR/disable_ipv6"
fi
V6_FORWARD_CHAIN=FORWARD
ip6tables -n -L DOCKER-USER > /dev/null 2>&1 && V6_FORWARD_CHAIN=DOCKER-USER
ip6tables -C "$V6_FORWARD_CHAIN" -i "$BR" -j REJECT 2> /dev/null || ip6tables -I "$V6_FORWARD_CHAIN" 1 -i "$BR" -j REJECT
ip6tables -C INPUT -i "$BR" -j REJECT 2> /dev/null || ip6tables -I INPUT 1 -i "$BR" -j REJECT

echo "agent browser firewall applied: $BR ($SUBNET), host $HOST_IP"
