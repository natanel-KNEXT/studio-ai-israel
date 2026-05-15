import { AppLayout } from '@/components/layout/AppLayout';
import { mockBrandSettings } from '@/data/mockData';
import { useState } from 'react';
import { Palette, Save } from 'lucide-react';
import { toast } from 'sonner';
import { VoiceDictationButton } from '@/components/VoiceDictationButton';

export default function BrandSettingsPage() {
  const [form, setForm] = useState(mockBrandSettings);
  const u = (key: string, val: any) => setForm(f => ({ ...f, [key]: val }));

  return (
    <AppLayout>
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-rubik font-bold flex items-center gap-2"><Palette className="w-6 h-6 text-primary" /> הגדרות מותג</h1>
            <p className="text-muted-foreground text-sm mt-1">הגדירו את זהות המותג שלכם לסרטונים</p>
          </div>
          <button onClick={() => toast.success('ההגדרות נשמרו')} className="gradient-gold text-primary-foreground px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2">
            <Save className="w-4 h-4" /> שמור
          </button>
        </div>

        {[
          { title: 'פרטי מותג', fields: [
            ['שם מותג', 'name'], ['סלוגן', 'slogan'], ['תיאור', 'description'],
            ['טון דיבור', 'tone'], ['סגנון שפה', 'languageStyle'], ['קהל יעד', 'targetAudience'],
          ]},
          { title: 'מסרים', fields: [
            ['CTA ברירת מחדל', 'defaultCta'], ['מבנה תוכן מועדף', 'contentStructure'],
          ]},
          { title: 'סגנון חזותי', fields: [
            ['סגנון כתוביות', 'subtitleStyle'], ['סגנון פתיח', 'introStyle'],
            ['סגנון סיום', 'outroStyle'], ['סגנון עריכה', 'editStyle'],
          ]},
        ].map(section => (
          <div key={section.title} className="bg-card border border-border rounded-xl p-6 space-y-4">
            <h2 className="font-rubik font-semibold">{section.title}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {section.fields.map(([label, key]) => (
                <div key={key}>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-medium">{label}</label>
                    <VoiceDictationButton onResult={(text) => u(key, ((form as any)[key] || '') + (((form as any)[key]) ? ' ' : '') + text)} />
                  </div>
                  <input value={(form as any)[key]} onChange={e => u(key, e.target.value)}
                    className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="bg-card border border-border rounded-xl p-6 space-y-4">
          <h2 className="font-rubik font-semibold">מילים ומסרים</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">מילים מועדפות</label>
              <p className="text-sm text-muted-foreground bg-muted/30 rounded-lg p-3">{form.preferredWords.join(', ')}</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">מילים אסורות</label>
              <p className="text-sm text-muted-foreground bg-muted/30 rounded-lg p-3">{form.forbiddenWords.join(', ')}</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">מסרים מרכזיים</label>
              <p className="text-sm text-muted-foreground bg-muted/30 rounded-lg p-3">{form.keyMessages.join(' • ')}</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">מסרים אסורים</label>
              <p className="text-sm text-muted-foreground bg-muted/30 rounded-lg p-3">{form.forbiddenMessages.join(' • ')}</p>
            </div>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl p-6">
          <h2 className="font-rubik font-semibold mb-3">צבעי מותג</h2>
          <div className="flex gap-3">
            {form.colors.map((c, i) => (
              <div key={i} className="text-center">
                <div className="w-12 h-12 rounded-lg border border-border" style={{ backgroundColor: c }} />
                <p className="text-[10px] text-muted-foreground mt-1">{c}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
