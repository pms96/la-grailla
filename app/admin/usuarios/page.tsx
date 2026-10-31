'use client';

import { useEffect, useState } from 'react';
import type { User, UserRole } from '@prisma/client';
import { useBrand } from '@/components/brand-provider';
import { useSession } from 'next-auth/react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Plus, Pencil, Trash2, Loader2, Users, KeyRound, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layouts/page-header';
import { RolesDialog, type CustomRole, type PresetRole } from './_components/roles-dialog';

type UserFormState = {
  name: string;
  email: string;
  password: string;
  role: UserRole;
  /** null = propietario (sin restricción). Solo cuenta para administradores. */
  accessRole: string | null;
};

const OWNER_VALUE = '__owner__';

export default function UsuariosPage() {
  const { data: session } = useSession() || {};
  // El rol de taquilla pertenece al módulo Entradas: sin él, un solo rol (administrador).
  const { modules } = useBrand();
  const hasTaquilla = modules.includes('entradas');
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [form, setForm] = useState<Partial<UserFormState>>({});
  const [saving, setSaving] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetting, setResetting] = useState(false);

  const [rolesOpen, setRolesOpen] = useState(false);
  const [roleData, setRoleData] = useState<{ presets: PresetRole[]; custom: CustomRole[] }>({ presets: [], custom: [] });

  const fetchUsers = () => {
    fetch('/api/admin/users')
      .then((r) => r.json())
      .then((d) => setUsers(Array.isArray(d) ? d : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  const fetchRoles = () => {
    fetch('/api/admin/roles')
      .then((r) => r.json())
      .then((d) => setRoleData({ presets: d?.presets ?? [], custom: d?.custom ?? [] }))
      .catch(() => {});
  };

  useEffect(() => { fetchUsers(); fetchRoles(); }, []);

  /** Nombre legible del rol por módulos de un usuario (alias del cliente o predefinido). */
  const accessRoleLabel = (key: string | null | undefined) => {
    if (!key) return null;
    if (key.startsWith('c_')) return roleData.custom.find((r) => `c_${r.id}` === key)?.name ?? 'Rol borrado';
    return roleData.presets.find((p) => p.key === key)?.label ?? key;
  };

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', email: '', password: '', role: hasTaquilla ? 'TAQUILLA' : 'ADMIN', accessRole: null });
    setDialogOpen(true);
  };

  const openEdit = (user: User) => {
    setEditing(user);
    setForm({ name: user?.name ?? '', role: user?.role ?? 'USER', accessRole: user?.accessRole ?? null });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const url = editing ? `/api/admin/users/${editing.id}` : '/api/admin/users';
      const method = editing ? 'PUT' : 'POST';
      // El rol por módulos solo existe para administradores.
      const payload = { ...form, accessRole: form?.role === 'ADMIN' ? (form?.accessRole ?? null) : null };
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (data?.error) toast.error(data.error);
      else { toast.success(editing ? 'Actualizado' : 'Creado'); setDialogOpen(false); fetchUsers(); }
    } catch { toast.error('Error'); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar este usuario?')) return;
    const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast.error(data?.error ?? 'No se pudo eliminar'); return; }
    toast.success('Eliminado');
    fetchUsers();
  };

  const openReset = (user: User) => {
    setResetTarget(user);
    setResetPassword('');
    setResetOpen(true);
  };

  const handleReset = async () => {
    if (!resetTarget) return;
    if (resetPassword.length < 8) { toast.error('La contraseña debe tener al menos 8 caracteres'); return; }
    setResetting(true);
    try {
      const res = await fetch(`/api/admin/users/${resetTarget.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: resetPassword }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) { toast.error(data?.error ?? 'No se pudo restablecer la contraseña'); return; }
      toast.success('Contraseña actualizada');
      setResetOpen(false);
    } catch { toast.error('Error'); }
    finally { setResetting(false); }
  };

  const updateField = <K extends keyof UserFormState>(key: K, value: UserFormState[K]) =>
    setForm((prev) => ({ ...(prev ?? {}), [key]: value }));

  const handleChange = (key: 'name' | 'email' | 'password') => (e: React.ChangeEvent<HTMLInputElement>) =>
    updateField(key, e?.target?.value ?? '');

  const roleLabel = (r: string) => r === 'ADMIN' ? 'Admin' : r === 'TAQUILLA' ? 'Taquilla' : 'Usuario';

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageHeader title="Usuarios" description="Gestiona roles y accesos" />
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setRolesOpen(true)} className="gap-2"><ShieldCheck className="h-4 w-4" /> Roles</Button>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={openCreate} className="gap-2"><Plus className="h-4 w-4" /> Nuevo Usuario</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>{editing ? 'Editar Usuario' : 'Nuevo Usuario'}</DialogTitle></DialogHeader>
            <div className="space-y-4 mt-4">
              <div><Label>Nombre</Label><Input value={form?.name ?? ''} onChange={handleChange('name')} className="mt-1" /></div>
              {!editing && (
                <>
                  <div><Label>Email</Label><Input type="email" value={form?.email ?? ''} onChange={handleChange('email')} className="mt-1" /></div>
                  <div><Label>Contraseña</Label><Input type="password" value={form?.password ?? ''} onChange={handleChange('password')} className="mt-1" /></div>
                </>
              )}
              <div><Label>Rol</Label>
                <Select value={form?.role ?? 'USER'} onValueChange={(v: UserRole) => updateField('role', v)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ADMIN">Admin</SelectItem>
                    {(hasTaquilla || form?.role === 'TAQUILLA') && <SelectItem value="TAQUILLA">Taquilla / RRPP</SelectItem>}
                    <SelectItem value="USER">Usuario</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form?.role === 'ADMIN' && (
                <div><Label>Qué puede administrar</Label>
                  <Select value={form?.accessRole ?? OWNER_VALUE} onValueChange={(v: string) => updateField('accessRole', v === OWNER_VALUE ? null : v)}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={OWNER_VALUE}>Todo (propietario)</SelectItem>
                      {roleData.presets.map((p) => <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>)}
                      {roleData.custom.map((r) => <SelectItem key={r.id} value={`c_${r.id}`}>{r.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-1">Con un rol, esta persona solo ve y usa los módulos de ese rol y no gestiona usuarios. Si le cambias el rol, tendrá que entrar de nuevo.</p>
                </div>
              )}
              <Button onClick={handleSave} disabled={saving} className="w-full">
                {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                {editing ? 'Guardar' : 'Crear'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <RolesDialog
        open={rolesOpen}
        onOpenChange={setRolesOpen}
        available={modules}
        presets={roleData.presets}
        custom={roleData.custom}
        onChanged={() => { fetchRoles(); fetchUsers(); }}
      />

      <div className="space-y-3">
        {(users ?? []).map((user) => (
          <Card key={user?.id}>
            <CardContent className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center font-bold text-primary">
                  {(user?.name ?? 'U')?.[0]?.toUpperCase?.() ?? 'U'}
                </div>
                <div>
                  <p className="font-medium">{user?.name ?? ''}</p>
                  <p className="text-xs text-muted-foreground">{user?.email ?? ''}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={user?.role === 'ADMIN' ? 'default' : 'secondary'}>
                  {user?.role === 'ADMIN' && user?.accessRole ? accessRoleLabel(user.accessRole) : roleLabel(user?.role ?? '')}
                </Badge>
                <Button variant="ghost" size="icon-sm" onClick={() => openReset(user)} title="Restablecer contraseña"><KeyRound className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon-sm" onClick={() => openEdit(user)}><Pencil className="h-3.5 w-3.5" /></Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={user?.id === session?.user?.id}
                  title={user?.id === session?.user?.id ? 'No puedes eliminar tu propia cuenta' : undefined}
                  onClick={() => handleDelete(user?.id)}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive-text" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Restablecer contraseña de {resetTarget?.name || resetTarget?.email}</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <Label>Nueva contraseña</Label>
              <Input
                type="password"
                value={resetPassword}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setResetPassword(e?.target?.value ?? '')}
                className="mt-1"
                placeholder="Mínimo 8 caracteres"
              />
            </div>
            <Button onClick={handleReset} disabled={resetting} className="w-full">
              {resetting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Restablecer
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
