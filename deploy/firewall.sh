#!/usr/bin/env bash
# Host firewall for SCAD (T3.1, INV1). Run as root after Docker is installed:
#   sudo bash deploy/firewall.sh && sudo netfilter-persistent save
#
# Internet: only 80/443 (Caddy) and 22 (SSH, from the VM image's own rules).
# Containers: only the platform network (Caddy, gateway: 172.31.250.0/24)
# may reach the control plane on port 4000; app containers reach no host
# service at all. Idempotent: rebuilds the SCAD-INPUT chain each run.
set -euo pipefail

EDGE_SUBNET="172.31.250.0/24"

iptables -N SCAD-INPUT 2>/dev/null || iptables -F SCAD-INPUT
iptables -A SCAD-INPUT -i lo -j RETURN
iptables -A SCAD-INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A SCAD-INPUT -s "$EDGE_SUBNET" -p tcp --dport 4000 -j ACCEPT
# Any other traffic from a Docker bridge to the host is refused.
iptables -A SCAD-INPUT -i docker0 -j REJECT
iptables -A SCAD-INPUT -i br+ -j REJECT
iptables -A SCAD-INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT
iptables -A SCAD-INPUT -p udp --dport 443 -j ACCEPT
iptables -A SCAD-INPUT -j RETURN

iptables -C INPUT -j SCAD-INPUT 2>/dev/null || iptables -I INPUT 1 -j SCAD-INPUT
echo "SCAD-INPUT installed. Persist with: sudo netfilter-persistent save"
