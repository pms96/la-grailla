'use client';

import { useEffect, useState } from 'react';
import type { User, UserRole } from '@prisma/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Plus, Pencil, Trash2, Loader2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layouts/page-header';

type UserFormState = {
  name: string;
  email: string;
  password: string;
  role: UserRole;
};

export default function UsuariosPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [form, setForm] = useState<Partial<UserFormState>>({});
  const [saving, setSaving] = useState(false);

  const fetchUsers = () => {
    fetch('/api/admin/users')
      .then((r) => r.json())
      .then((d) => setUsers(d ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchUsers(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', email: '', password: '', role: 'TAQUILLA' });
    setDialogOpen(true);
  };

  const openEdit = (user: User) => {
    setEditing(user);
    setForm({ name: user?.name ?? '', role: user?.role ?? 'USER' });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const url = editing ? `/api/admin/users/${editing.id}` : '/api/admin/users';
      const method = editing ? 'PUT' : 'POST';
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const data = await res.json();
      if (data?.error) toast.error(data.error);
      else { toast.success(editing ? 'Actualizado' : 'Creado'); setDialogOpen(false); fetchUsers(); }
    } catch { toast.error('Error'); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar este usuario?')) return;
    await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
    toast.success('Eliminado');
    fetchUsers();
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
                    <SelectItem value="TAQUILLA">Taquilla / RRPP</SelectItem>
                    <SelectItem value="USER">Usuario</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={handleSave} disabled={saving} className="w-full">
                {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                {editing ? 'Guardar' : 'Crear'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

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
                <Badge variant={user?.role === 'ADMIN' ? 'default' : 'secondary'}>{roleLabel(user?.role ?? '')}</Badge>
                <Button variant="ghost" size="icon-sm" onClick={() => openEdit(user)}><Pencil className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon-sm" onClick={() => handleDelete(user?.id)}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
