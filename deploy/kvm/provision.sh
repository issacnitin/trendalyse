#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "Usage: bash provision.sh /absolute/path/to/guest-ssh-key.pub" >&2
  exit 64
fi
key_path="$1"
uri=qemu:///system
for tool in virsh virt-install qemu-img cloud-localds curl python3 sha256sum; do
  command -v "$tool" >/dev/null
done
if virsh -c "$uri" dominfo trendalyse >/dev/null 2>&1; then
  echo "trendalyse already exists; refusing to overwrite it." >&2
  exit 1
fi
if virsh -c "$uri" net-info trendalyse >/dev/null 2>&1; then
  echo "trendalyse network already exists; inspect it before provisioning." >&2
  exit 1
fi
if virsh -c "$uri" nwfilter-dumpxml trendalyse-egress >/dev/null 2>&1 || virsh -c "$uri" pool-info trendalyse >/dev/null 2>&1; then
  echo "Trendalyse filter or storage pool already exists; inspect partial provisioning before retrying." >&2
  exit 1
fi
if ip -4 route | grep -q '172.29.245.0/24'; then
  echo "172.29.245.0/24 is already in use." >&2
  exit 1
fi
mkdir -p staging
chmod 700 staging
if [[ ! -s staging/base.img || ! -s staging/SHA256SUMS ]]; then
  curl -fsSL https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img -o staging/base.img
  curl -fsSL https://cloud-images.ubuntu.com/noble/current/SHA256SUMS -o staging/SHA256SUMS
fi
(cd staging && grep ' [*]noble-server-cloudimg-amd64.img$' SHA256SUMS | sed 's/noble-server-cloudimg-amd64.img/base.img/' | sha256sum -c -)
qemu-img convert -O qcow2 staging/base.img staging/disk.qcow2
qemu-img resize staging/disk.qcow2 30G
python3 - "$key_path" <<'PY'
import pathlib, re, sys
key = pathlib.Path(sys.argv[1]).read_text().strip()
if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]+(?: [A-Za-z0-9._@-]+)?', key):
    raise SystemExit('Expected a single ed25519 public key')
template = pathlib.Path('cloud-init.yaml').read_text()
pathlib.Path('staging/user-data').write_text(template.replace('PUBLIC_SSH_KEY', key))
PY
cloud-localds --network-config=network-config.yaml staging/seed.iso staging/user-data
virsh -c "$uri" nwfilter-define filter.xml --validate
virsh -c "$uri" net-define network.xml --validate
virsh -c "$uri" net-start trendalyse
virsh -c "$uri" net-autostart trendalyse
virsh -c "$uri" pool-define-as trendalyse dir --target /var/lib/libvirt/images/trendalyse
virsh -c "$uri" pool-build trendalyse
virsh -c "$uri" pool-start trendalyse
virsh -c "$uri" pool-autostart trendalyse
virsh -c "$uri" vol-create-as trendalyse disk.qcow2 30G --format qcow2
virsh -c "$uri" vol-upload --pool trendalyse disk.qcow2 staging/disk.qcow2 --sparse
virsh -c "$uri" vol-create-as trendalyse seed.iso "$(stat -c %s staging/seed.iso)" --format raw
virsh -c "$uri" vol-upload --pool trendalyse seed.iso staging/seed.iso
virt-install --connect "$uri" --name trendalyse --memory 4096 --vcpus 2 \
  --os-variant ubuntu24.04 --import --noautoconsole --graphics none \
  --disk vol=trendalyse/disk.qcow2,bus=virtio \
  --disk vol=trendalyse/seed.iso,device=cdrom \
  --network network=trendalyse,model=virtio,mac=52:54:00:74:61:01,filterref.filter=trendalyse-egress \
  --print-xml > staging/guest.xml
python3 - <<'PY'
import xml.etree.ElementTree as ET
tree = ET.parse('staging/guest.xml')
ref = tree.find("./devices/interface/filterref")
if ref is None:
    raise SystemExit('Missing mandatory network filter; refusing to start the guest')
ET.SubElement(ref, 'parameter', name='IP', value='172.29.245.10')
tree.write('staging/guest.xml')
PY
virsh -c "$uri" define staging/guest.xml
virsh -c "$uri" start trendalyse
virsh -c "$uri" autostart trendalyse
echo "Guest created: 172.29.245.10. SSH from the host after cloud-init finishes."
