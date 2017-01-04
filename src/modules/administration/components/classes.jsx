import AdminSection from './admin-section';
import ModalForm from './modal-form';
import Table from './table';

class SectionClasses extends AdminSection {

	constructor(props) {
		super(props);

		this.options = {
			title: 'Klassen',
			addLabel: 'Klasse hinzufügen',
			editLabel: 'Klasse bearbeiten',
			submitCallback: (data) => {
				this.props.actions.updateClass(data);
			}
		};

		this.defaultRecord = {
			name: '',
			schoolId: this.props.school._id
		};

		this.actions = [
			{
				action: this.openModal.bind(this),
				icon: 'edit'
			},
			{
				action: this.removeRecord.bind(this),
				icon: 'trash-o'
			}
		]
	}

	modalFormUI() {
		const record = this.state.record;
		return (
			<div className="edit-form">
				<div className="form-group">
					<label htmlFor="">Name der Klasse *</label>
					<input
						type="text"
						value={record.name}
						className="form-control"
						name="name"
						placeholder="10a"
						onChange={this.handleRecordChange.bind(this)}
						required />
				</div>

				<div className="form-group">
					<label htmlFor="">Klassenlehrer</label>
					<select
						value={record.teacherIds}
						className="form-control"
						name="teacherIds"
						onChange={this.handleRecordChange.bind(this)}
						required
						multiple>
						{this.props.teachers.map((r) => {
							return (<option key={r._id} value={r._id}>{r.userName || r._id}</option>);
						})}
					</select>
				</div>
			</div>
		);
	}

	removeRecord(record) {
		this.props.actions.removeClass(record);
	}

	getTableHead() {
		return [
			'ID',
			'Bezeichnung',
			'Erstellt am',
			''
		];
	}

	getTableBody() {
		return this.props.classes.map((c) => {
			return [
				c._id,
				c.name,
				c.createdAt,
				this.getTableActions(this.actions, c)
			];
		});
	}
}

export default SectionClasses;
